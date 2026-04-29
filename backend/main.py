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
