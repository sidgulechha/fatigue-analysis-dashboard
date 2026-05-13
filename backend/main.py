import os
import glob
import math
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Fatigue Monitor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache: participant_id -> list of epoch dicts
_epoch_cache: dict[str, list] = {}

DATA_DIR = os.path.join(os.path.dirname(__file__), "..")

STAGE_ORDER = {"W": 0, "N1": 1, "N2": 2, "N3": 3, "R": 4}
STAGE_BASE_FATIGUE = {"W": 40, "N1": 25, "N2": 10, "N3": 5, "R": 20}

ROWS_PER_EPOCH = 1920  # 30 s × 64 Hz

CIRCADIAN = {
    0: 30, 1: 25, 2: 20, 3: 15, 4: 15, 5: 20, 6: 35, 7: 55, 8: 70,
    9: 85, 10: 90, 11: 90, 12: 85, 13: 75, 14: 65, 15: 70, 16: 75,
    17: 80, 18: 85, 19: 85, 20: 80, 21: 70, 22: 55, 23: 40,
}


def _compute_fatigue(sleep_stage: str, mean_hr: float, hr_std: float, movement: float) -> float:
    score = float(STAGE_BASE_FATIGUE.get(sleep_stage, 20))

    if mean_hr > 80:
        score += 20
    elif mean_hr >= 65:
        score += 10

    if hr_std > 3.0:
        score += 20
    elif hr_std >= 1.0:
        score += 10

    if movement > 2.0:
        score += 20
    elif movement >= 1.0:
        score += 10

    return float(max(0.0, min(100.0, score)))


def _load_epochs(participant_id: str) -> list:
    pattern = os.path.join(DATA_DIR, f"{participant_id}_whole_df.csv")
    matches = glob.glob(pattern)
    if not matches:
        raise FileNotFoundError(f"No CSV found for participant {participant_id}")

    df = pd.read_csv(matches[0])

    # Filter out preparation stage
    df = df[df["Sleep_Stage"] != "P"].reset_index(drop=True)

    # Reset time to start at 0
    min_ts = df["TIMESTAMP"].min()
    df["TIMESTAMP"] = df["TIMESTAMP"] - min_ts

    # Precompute magnitude once
    df["_mag"] = np.sqrt(
        df["ACC_X"] ** 2 + df["ACC_Y"] ** 2 + df["ACC_Z"] ** 2
    )

    # Assign epoch index
    df["_epoch_idx"] = df.index // ROWS_PER_EPOCH

    apnea_cols = ["Obstructive_Apnea", "Central_Apnea", "Hypopnea", "Multiple_Events"]

    epochs = []
    for epoch_idx, group in df.groupby("_epoch_idx", sort=True):
        sleep_stage = group["Sleep_Stage"].mode().iloc[0] if not group["Sleep_Stage"].mode().empty else "W"

        mean_hr = float(group["HR"].mean())
        hr_std = float(group["HR"].std(ddof=0))
        movement = float(group["_mag"].std(ddof=0))
        eda_mean = float(group["EDA"].mean())
        temp_mean = float(group["TEMP"].mean())

        # Handle NaN
        if math.isnan(mean_hr):
            mean_hr = 0.0
        if math.isnan(hr_std):
            hr_std = 0.0
        if math.isnan(movement):
            movement = 0.0
        if math.isnan(eda_mean):
            eda_mean = 0.0
        if math.isnan(temp_mean):
            temp_mean = 0.0

        has_apnea = bool(
            any(
                group[col].notna().any()
                for col in apnea_cols
                if col in group.columns
            )
        )

        time_hours = float(group["TIMESTAMP"].iloc[0]) / 3600.0

        fatigue_score = _compute_fatigue(sleep_stage, mean_hr, hr_std, movement)

        epochs.append(
            {
                "epoch_idx": int(epoch_idx),
                "time_hours": round(time_hours, 4),
                "sleep_stage": sleep_stage,
                "mean_hr": round(mean_hr, 2),
                "hr_std": round(hr_std, 2),
                "movement": round(movement, 4),
                "eda_mean": round(eda_mean, 4),
                "temp_mean": round(temp_mean, 2),
                "has_apnea": has_apnea,
                "fatigue_score": round(fatigue_score, 1),
            }
        )

    return epochs


@app.get("/participants")
def get_participants():
    pattern = os.path.join(DATA_DIR, "S*_whole_df.csv")
    files = glob.glob(pattern)
    ids = sorted(
        os.path.basename(f).replace("_whole_df.csv", "") for f in files
    )
    return ids


@app.get("/participant/{participant_id}/epochs")
def get_epochs(participant_id: str):
    if participant_id not in _epoch_cache:
        try:
            _epoch_cache[participant_id] = _load_epochs(participant_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
    return _epoch_cache[participant_id]


@app.get("/participant/{participant_id}/schedule")
def get_schedule(participant_id: str):
    if participant_id not in _epoch_cache:
        try:
            _epoch_cache[participant_id] = _load_epochs(participant_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    epochs = _epoch_cache[participant_id]
    if not epochs:
        raise HTTPException(status_code=422, detail="No epochs found")

    sleep_epochs = [e for e in epochs if e["sleep_stage"] != "W"]
    wake_epochs  = [e for e in epochs if e["sleep_stage"] == "W"]
    rem_epochs   = [e for e in epochs if e["sleep_stage"] == "R"]
    n = len(epochs)

    avg_sleep_fatigue = (
        sum(e["fatigue_score"] for e in sleep_epochs) / len(sleep_epochs)
        if sleep_epochs else 0.0
    )
    wake_pct    = len(wake_epochs) / n * 100
    rem_pct     = len(rem_epochs)  / n * 100
    rem_deficit = max(0.0, 20.0 - rem_pct)

    fatigue_penalty  = avg_sleep_fatigue
    wake_penalty     = min(wake_pct * 2, 100.0)
    rem_penalty      = min(rem_deficit * 5, 100.0)
    weighted_penalty = 0.40 * fatigue_penalty + 0.35 * wake_penalty + 0.25 * rem_penalty
    recovery_score   = round(100.0 - weighted_penalty, 1)

    if recovery_score >= 70:
        duty_category     = "Full Duty"
        duty_color        = "green"
        max_shift         = 8
        critical_eligible = True
    elif recovery_score >= 40:
        duty_category     = "Reduced Duty"
        duty_color        = "amber"
        max_shift         = 6
        critical_eligible = False
    else:
        duty_category     = "Rest Recommended"
        duty_color        = "red"
        max_shift         = 4
        critical_eligible = False

    scale = recovery_score / 100.0
    alertness_by_hour = {
        str(h): round(CIRCADIAN[h] * (0.4 + 0.6 * scale), 1)
        for h in range(24)
    }
    alertness_vals = [alertness_by_hour[str(h)] for h in range(24)]

    best_avg   = -1.0
    best_start = 6
    for start in range(6, 25 - max_shift):
        window_avg = sum(alertness_vals[start : start + max_shift]) / max_shift
        if window_avg > best_avg:
            best_avg   = window_avg
            best_start = start

    # Fallback if loop somehow produced no result (e.g. very large max_shift)
    if best_avg < 0:
        for start in range(0, 25 - max_shift):
            window_avg = sum(alertness_vals[start : start + max_shift]) / max_shift
            if window_avg > best_avg:
                best_avg   = window_avg
                best_start = start

    best_end   = best_start + max_shift
    start_str  = f"{best_start:02d}:00"
    end_str    = f"{best_end:02d}:00"

    if duty_category == "Full Duty":
        rec_text = (
            f"Schedule for full duties {start_str}–{end_str}; cleared for safety-critical roles."
        )
    elif duty_category == "Reduced Duty":
        rec_text = (
            f"Schedule for standard duties {start_str}–{end_str}. "
            f"Avoid overnight watches and safety-critical roles."
        )
    else:
        rec_text = (
            f"Rest recommended; if deployment is essential, limit to {start_str}–{end_str} "
            f"on non-critical tasks only."
        )

    return {
        "participant_id":        participant_id,
        "recovery_score":        recovery_score,
        "duty_category":         duty_category,
        "duty_color":            duty_color,
        "max_shift_hours":       max_shift,
        "critical_duty_eligible": critical_eligible,
        "recommended_shift_start": best_start,
        "recommended_shift_end":   best_end,
        "recommendation_text":   rec_text,
        "alertness_by_hour":     alertness_by_hour,
        "recovery_breakdown": {
            "avg_sleep_fatigue": round(avg_sleep_fatigue, 1),
            "wake_pct":          round(wake_pct, 1),
            "rem_pct":           round(rem_pct, 1),
            "fatigue_penalty":   round(fatigue_penalty, 1),
            "wake_penalty":      round(wake_penalty, 1),
            "rem_penalty":       round(rem_penalty, 1),
            "weighted_penalty":  round(weighted_penalty, 1),
        },
    }
