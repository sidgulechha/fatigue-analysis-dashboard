# Fatigue Monitor — DREAMT Dataset

A real-time sleep and fatigue analysis dashboard built on polysomnography data from the DREAMT dataset.

---

## Preview

![Dashboard — summary cards, hypnogram, and fatigue score](docs/dashboard-top.png)

![Dashboard — heart rate and EDA biosignals](docs/dashboard-bottom.png)

---

## Project Layout

```
.
├── S002_whole_df.csv       ← participant data (2M+ rows each)
├── S003_whole_df.csv
├── ...
├── InitialAnalysis.ipynb   ← existing notebook
├── backend/
│   ├── main.py             ← FastAPI app
│   └── requirements.txt
├── frontend/
│   ├── public/index.html
│   └── src/
│       ├── index.js
│       ├── App.js
│       └── App.css
└── README.md
```

---

## Setup & Run

### 1 — Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.  
Swagger docs: `http://localhost:8000/docs`

> **First load per participant takes 5–10 seconds** (parsing ~130 MB CSV).  
> Subsequent requests for the same participant are served from in-memory cache.

### 2 — Frontend

```bash
cd frontend
npm install
npm start
```

The dashboard opens at `http://localhost:3000`.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/participants` | List of participant IDs found in parent directory |
| `GET` | `/participant/{id}/epochs` | All 30-second epochs for a participant |

### Epoch fields

| Field | Type | Description |
|-------|------|-------------|
| `epoch_idx` | int | Sequential epoch number |
| `time_hours` | float | Start time (hours from recording start) |
| `sleep_stage` | string | W / N1 / N2 / N3 / R |
| `mean_hr` | float | Mean heart rate (bpm) |
| `hr_std` | float | HR standard deviation |
| `movement` | float | Std dev of accelerometer magnitude |
| `eda_mean` | float | Mean electrodermal activity (μS) |
| `temp_mean` | float | Mean skin temperature (°C) |
| `has_apnea` | bool | Any apnea/hypopnea event in epoch |
| `fatigue_score` | float | Heuristic fatigue score 0–100 |

### Fatigue Score Heuristic

```
base      = stage_base[sleep_stage]   # W=40, N1=25, N2=10, N3=5, R=20
hr_bonus  = 20 if hr>80 else 10 if hr≥65 else 0
std_bonus = 20 if std>3 else 10 if std≥1 else 0
mov_bonus = 20 if mov>2 else 10 if mov≥1 else 0
score     = clamp(base + hr_bonus + std_bonus + mov_bonus, 0, 100)
```

---

## Dashboard Panels

1. **Summary Cards** — Total Sleep Time · Wake % · REM % · Avg HR · Avg Fatigue Score
2. **Hypnogram** — Step chart of sleep stages across the night, color-coded per stage
3. **Fatigue Score** — Raw score (faint) + 5-epoch rolling average (bold); apnea epochs shaded; reference lines at 30 (low) and 60 (high)
4. **Biosignals** — HR over time (red) and EDA over time (blue)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.10+, FastAPI, Pandas, NumPy |
| Frontend | React 18, Recharts, Axios |
