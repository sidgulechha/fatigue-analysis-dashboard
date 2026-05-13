import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import {
  ComposedChart,
  Bar,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import './App.css';

const API = 'http://localhost:8000';

// Sleep stage numeric mapping for hypnogram (higher = lighter sleep / more awake)
const STAGE_NUM = { W: 5, N1: 4, N2: 3, N3: 1, R: 2 };
const STAGE_LABEL = { 5: 'W', 4: 'N1', 3: 'N2', 1: 'N3', 2: 'REM' };
const STAGE_COLOR = {
  W:  '#e74c3c',
  N1: '#e67e22',
  N2: '#3498db',
  N3: '#1a5276',
  R:  '#8e44ad',
};

const DUTY_COLORS = { green: '#27ae60', amber: '#f39c12', red: '#e74c3c' };

function alertnessBarColor(v) {
  if (v >= 70) return '#2ecc71';
  if (v >= 50) return '#f39c12';
  return '#e74c3c';
}

function recoveryScoreColor(score) {
  if (score >= 70) return '#27ae60';
  if (score >= 40) return '#f39c12';
  return '#e74c3c';
}

function hourLabel(h) {
  if (h === 0)  return '12am';
  if (h < 12)   return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

// Shared chart axis / grid props
const TICK_STYLE = { fill: '#868e96', fontSize: 11, fontFamily: 'Instrument Sans, system-ui, sans-serif' };
const GRID_STROKE = '#e9ecef';
const AXIS_LINE = { stroke: '#dee2e6' };

function rollingAverage(data, key, window) {
  return data.map((d, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = data.slice(start, i + 1);
    const avg = slice.reduce((s, x) => s + x[key], 0) / slice.length;
    return { ...d, [`${key}_avg`]: Math.round(avg * 10) / 10 };
  });
}

// ── Tooltip shell ──────────────────────────────────────────────────────────────
const TooltipBox = ({ children }) => (
  <div style={{
    background: '#fff',
    border: '1px solid #dee2e6',
    borderRadius: 6,
    padding: '8px 12px',
    fontFamily: 'Instrument Sans, system-ui, sans-serif',
    fontSize: 12,
    color: '#495057',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  }}>
    {children}
  </div>
);

const HypnogramTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <TooltipBox>
      <div style={{ color: '#212529', fontWeight: 600, marginBottom: 3 }}>{d.time_hours.toFixed(2)} h</div>
      <div>Stage: <span style={{ color: STAGE_COLOR[d.sleep_stage] || '#495057', fontWeight: 500 }}>{d.sleep_stage}</span></div>
      {d.has_apnea && <div style={{ color: '#868e96', marginTop: 3 }}>Apnea event</div>}
    </TooltipBox>
  );
};

const FatigueTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <TooltipBox>
      <div style={{ color: '#212529', fontWeight: 600, marginBottom: 3 }}>{d.time_hours.toFixed(2)} h</div>
      <div style={{ color: '#adb5bd' }}>Raw: <span style={{ color: '#495057' }}>{d.fatigue_score}</span></div>
      {d.fatigue_score_avg !== undefined && (
        <div>5-epoch avg: <span style={{ color: '#212529', fontWeight: 500 }}>{d.fatigue_score_avg}</span></div>
      )}
      {d.has_apnea && <div style={{ color: '#868e96', marginTop: 3 }}>Apnea event</div>}
    </TooltipBox>
  );
};

const SignalTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <TooltipBox>
      <div style={{ color: '#212529', fontWeight: 600, marginBottom: 3 }}>{Number(label).toFixed(2)} h</div>
      {payload.map((p) => (
        <div key={p.dataKey}>
          {p.name}: <span style={{ color: p.color, fontWeight: 500 }}>{Number(p.value).toFixed(2)}</span>
        </div>
      ))}
    </TooltipBox>
  );
};

// ── Hypnogram dot — colored by sleep stage ─────────────────────────────────────
const HypnogramDot = (props) => {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  return <circle cx={cx} cy={cy} r={2.5} fill={STAGE_COLOR[payload.sleep_stage] || '#adb5bd'} stroke="none" />;
};

// ── Summary card ───────────────────────────────────────────────────────────────
const SummaryCard = ({ label, value, unit }) => (
  <div className="summary-card">
    <div className="card-label">{label}</div>
    <div className="card-value">
      {value}
      {unit && <span className="card-unit">{unit}</span>}
    </div>
  </div>
);

const RecoveryCard = ({ score, category }) => {
  const color = recoveryScoreColor(score);
  return (
    <div className="summary-card">
      <div className="card-label">RECOVERY SCORE</div>
      <div className="card-value" style={{ color }}>
        {score}
        <span className="card-unit">/ 100</span>
      </div>
      <div style={{ fontSize: 11, color, fontWeight: 500, marginTop: 5 }}>{category}</div>
    </div>
  );
};

// ── Section wrapper ────────────────────────────────────────────────────────────
const Section = ({ title, badge, children }) => (
  <div className="section">
    <div className="section-header">
      <span className="section-title">{title}</span>
      {badge && <span className="section-badge">{badge}</span>}
    </div>
    <div className="section-body">{children}</div>
  </div>
);

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [participants, setParticipants] = useState([]);
  const [selected, setSelected] = useState('');
  const [epochs, setEpochs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [schedule, setSchedule] = useState(null);

  useEffect(() => {
    axios.get(`${API}/participants`)
      .then((r) => {
        setParticipants(r.data);
        if (r.data.length > 0) setSelected(r.data[0]);
      })
      .catch(() => setError('Cannot reach backend. Is the server running on port 8000?'));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setError('');
    setEpochs([]);
    setSchedule(null);
    axios.get(`${API}/participant/${selected}/epochs`)
      .then((r) => { setEpochs(r.data); setLoading(false); })
      .catch((e) => { setError(`Failed to load data for ${selected}: ${e.message}`); setLoading(false); });
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    axios.get(`${API}/participant/${selected}/schedule`)
      .then((r) => setSchedule(r.data))
      .catch(() => {});
  }, [selected]);

  const enriched = useMemo(() => rollingAverage(epochs, 'fatigue_score', 5), [epochs]);

  const hypnogramData = useMemo(
    () => enriched.map((d) => ({ ...d, stage_num: STAGE_NUM[d.sleep_stage] ?? 3 })),
    [enriched]
  );

  // Merge contiguous apnea spans into reference areas
  const apneaAreas = useMemo(() => {
    const areas = [];
    let start = null;
    enriched.forEach((d, i) => {
      if (d.has_apnea && start === null) start = d.time_hours;
      if (!d.has_apnea && start !== null) {
        areas.push({ x1: start, x2: enriched[i - 1]?.time_hours ?? d.time_hours });
        start = null;
      }
    });
    if (start !== null) areas.push({ x1: start, x2: enriched[enriched.length - 1]?.time_hours });
    return areas;
  }, [enriched]);

  const alertnessData = useMemo(() => {
    if (!schedule) return [];
    return Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      alertness: schedule.alertness_by_hour[String(h)],
    }));
  }, [schedule]);

  const stats = useMemo(() => {
    if (!epochs.length) return null;
    const n = epochs.length;
    const wakeN = epochs.filter((e) => e.sleep_stage === 'W').length;
    const remN  = epochs.filter((e) => e.sleep_stage === 'R').length;
    return {
      totalHours: ((n * 30) / 3600).toFixed(1),
      wakePct:    ((wakeN / n) * 100).toFixed(0),
      remPct:     ((remN  / n) * 100).toFixed(0),
      avgHr:      (epochs.reduce((s, e) => s + e.mean_hr,       0) / n).toFixed(1),
      avgFatigue: (epochs.reduce((s, e) => s + e.fatigue_score, 0) / n).toFixed(1),
    };
  }, [epochs]);

  return (
    <div className="app">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <div className="logo-mark" aria-hidden="true" />
          <div>
            <h1 className="header-title">Fatigue monitor</h1>
            <p className="header-sub">DREAMT dataset · Polysomnography analysis</p>
          </div>
        </div>

        <div className="header-right">
          <label className="select-label" htmlFor="participant-select">Participant</label>
          <div className="select-wrap">
            <select
              id="participant-select"
              className="participant-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={loading}
            >
              {participants.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <span className="select-arrow">▼</span>
          </div>
        </div>
      </header>

      {/* ── Error banner ───────────────────────────────────────────────────── */}
      {error && (
        <div className="error-banner">
          <span className="error-icon">⚠</span>
          {error}
        </div>
      )}

      {/* ── Loading ────────────────────────────────────────────────────────── */}
      {loading && (
        <div className="loading-overlay">
          <div className="loader">
            <div className="loader-ring" />
            <div className="loader-ring" />
            <div className="loader-ring" />
          </div>
          <p className="loading-text">Loading {selected} — parsing ~2 M rows…</p>
        </div>
      )}

      {/* ── Dashboard ──────────────────────────────────────────────────────── */}
      {!loading && epochs.length > 0 && (
        <main className="dashboard">

          {/* Summary cards */}
          <div className="cards-row">
            <SummaryCard label="Total sleep time" value={stats.totalHours} unit="hrs" />
            <SummaryCard label="Wake"              value={stats.wakePct}   unit="%" />
            <SummaryCard label="REM"               value={stats.remPct}    unit="%" />
            <SummaryCard label="Mean heart rate"   value={stats.avgHr}     unit="bpm" />
            <SummaryCard label="Mean fatigue score" value={stats.avgFatigue} unit="/ 100" />
            {schedule && <RecoveryCard score={schedule.recovery_score} category={schedule.duty_category} />}
          </div>

          {/* ── Hypnogram ────────────────────────────────────────────────── */}
          <Section title="Hypnogram" badge={`${epochs.length} epochs · 30 s each`}>
            <ResponsiveContainer width="100%" height={180}>
              <ComposedChart data={hypnogramData} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 6" stroke={GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="time_hours"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => `${v.toFixed(1)} h`}
                  tick={TICK_STYLE}
                  axisLine={AXIS_LINE}
                  tickLine={false}
                />
                <YAxis
                  type="number"
                  domain={[0.5, 5.5]}
                  ticks={[1, 2, 3, 4, 5]}
                  tickFormatter={(v) => STAGE_LABEL[v] ?? ''}
                  tick={TICK_STYLE}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <Tooltip content={<HypnogramTooltip />} />
                <Line
                  type="stepAfter"
                  dataKey="stage_num"
                  stroke="#ced4da"
                  strokeWidth={1}
                  dot={<HypnogramDot />}
                  activeDot={{ r: 4, fill: '#495057', stroke: '#fff', strokeWidth: 1 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </Section>

          {/* ── Fatigue score ─────────────────────────────────────────────── */}
          <Section title="Fatigue score" badge="5-epoch rolling average">
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={enriched} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 6" stroke={GRID_STROKE} vertical={false} />

                {/* Apnea epoch shading */}
                {apneaAreas.map((a, i) => (
                  <ReferenceArea
                    key={i}
                    x1={a.x1}
                    x2={a.x2}
                    fill="rgba(0,0,0,0.04)"
                    stroke="rgba(0,0,0,0.07)"
                    strokeWidth={0.5}
                  />
                ))}

                <XAxis
                  dataKey="time_hours"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => `${v.toFixed(1)} h`}
                  tick={TICK_STYLE}
                  axisLine={AXIS_LINE}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 20, 40, 60, 80, 100]}
                  tick={TICK_STYLE}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <Tooltip content={<FatigueTooltip />} />

                <ReferenceLine
                  y={60}
                  stroke="#adb5bd"
                  strokeDasharray="4 4"
                  label={{
                    value: 'High fatigue',
                    position: 'insideTopRight',
                    fill: '#adb5bd',
                    fontSize: 10,
                    fontFamily: 'Instrument Sans, system-ui, sans-serif',
                  }}
                />
                <ReferenceLine
                  y={30}
                  stroke="#ced4da"
                  strokeDasharray="4 4"
                  label={{
                    value: 'Low fatigue',
                    position: 'insideTopRight',
                    fill: '#ced4da',
                    fontSize: 10,
                    fontFamily: 'Instrument Sans, system-ui, sans-serif',
                  }}
                />

                {/* Raw score — faint */}
                <Line
                  type="monotone"
                  dataKey="fatigue_score"
                  stroke="rgba(44,62,80,0.2)"
                  strokeWidth={1}
                  dot={false}
                  isAnimationActive={false}
                  name="Raw"
                />
                {/* 5-epoch rolling average — prominent */}
                <Line
                  type="monotone"
                  dataKey="fatigue_score_avg"
                  stroke="#2c3e50"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  name="5-epoch avg"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </Section>

          {/* ── Biosignals ────────────────────────────────────────────────── */}
          <Section title="Biosignals">
            <div className="signal-label">Heart rate (bpm)</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={enriched} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 6" stroke={GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="time_hours"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => `${v.toFixed(1)} h`}
                  tick={TICK_STYLE}
                  axisLine={AXIS_LINE}
                  tickLine={false}
                />
                <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={36} />
                <Tooltip content={<SignalTooltip />} />
                <Line
                  type="monotone"
                  dataKey="mean_hr"
                  stroke="#c0392b"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  name="HR"
                />
              </LineChart>
            </ResponsiveContainer>

            <div className="signal-label" style={{ marginTop: 18 }}>Electrodermal activity (μS)</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={enriched} margin={{ top: 5, right: 20, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 6" stroke={GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="time_hours"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => `${v.toFixed(1)} h`}
                  tick={TICK_STYLE}
                  axisLine={AXIS_LINE}
                  tickLine={false}
                />
                <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={36} />
                <Tooltip content={<SignalTooltip />} />
                <Line
                  type="monotone"
                  dataKey="eda_mean"
                  stroke="#2980b9"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  name="EDA"
                />
              </LineChart>
            </ResponsiveContainer>
          </Section>

          {/* ── Shift Recommendation ─────────────────────────────────────── */}
          {schedule && (
            <Section title="Shift Recommendation">

              {/* Part A — Duty status row */}
              <div className="duty-info-row">
                <div className="duty-info-box">
                  <div className="duty-info-label">Duty Category</div>
                  <div className="duty-info-value" style={{ color: DUTY_COLORS[schedule.duty_color] }}>
                    {schedule.duty_category}
                  </div>
                </div>
                <div className="duty-info-box">
                  <div className="duty-info-label">Max Shift Length</div>
                  <div className="duty-info-value">{schedule.max_shift_hours} hours</div>
                </div>
                <div className="duty-info-box">
                  <div className="duty-info-label">Critical Duty Eligible</div>
                  <div
                    className="duty-info-value"
                    style={{ color: schedule.critical_duty_eligible ? '#27ae60' : '#e74c3c' }}
                  >
                    {schedule.critical_duty_eligible ? 'Yes' : 'No'}
                  </div>
                </div>
              </div>

              {/* Part B — 24-hour alertness timeline */}
              <div className="signal-label" style={{ marginBottom: 6 }}>24-hour alertness</div>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={alertnessData} margin={{ top: 10, right: 20, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 6" stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="hour"
                    interval={0}
                    tickFormatter={(v) => (Number(v) % 6 === 0 ? hourLabel(Number(v)) : '')}
                    tick={TICK_STYLE}
                    axisLine={AXIS_LINE}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tick={TICK_STYLE}
                    axisLine={false}
                    tickLine={false}
                    width={36}
                  />
                  <Tooltip
                    content={(props) => {
                      if (!props.active || !props.payload?.length) return null;
                      const d = props.payload[0].payload;
                      const inWindow =
                        d.hour >= schedule.recommended_shift_start &&
                        d.hour < schedule.recommended_shift_end;
                      return (
                        <TooltipBox>
                          <div style={{ color: '#212529', fontWeight: 600, marginBottom: 3 }}>
                            {hourLabel(d.hour)}
                          </div>
                          <div>
                            Alertness:{' '}
                            <span style={{ color: alertnessBarColor(d.alertness), fontWeight: 500 }}>
                              {d.alertness}
                            </span>
                          </div>
                          {inWindow && (
                            <div style={{ color: '#868e96', marginTop: 3 }}>In recommended shift</div>
                          )}
                        </TooltipBox>
                      );
                    }}
                  />
                  <ReferenceLine
                    y={50}
                    stroke="#adb5bd"
                    strokeDasharray="4 4"
                    label={{
                      value: 'min threshold',
                      position: 'insideTopRight',
                      fill: '#adb5bd',
                      fontSize: 10,
                      fontFamily: 'Instrument Sans, system-ui, sans-serif',
                    }}
                  />
                  <ReferenceArea
                    x1={schedule.recommended_shift_start}
                    x2={schedule.recommended_shift_end - 1}
                    fill="rgba(44,62,80,0.07)"
                    stroke="rgba(44,62,80,0.25)"
                    strokeWidth={1}
                  />
                  <Bar dataKey="alertness" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                    {alertnessData.map((entry) => (
                      <Cell
                        key={`cell-${entry.hour}`}
                        fill={alertnessBarColor(entry.alertness)}
                        opacity={
                          entry.hour >= schedule.recommended_shift_start &&
                          entry.hour < schedule.recommended_shift_end
                            ? 1
                            : 0.45
                        }
                      />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>

              {/* Part C — Recommendation text */}
              <div className="rec-text-box">{schedule.recommendation_text}</div>

            </Section>
          )}

          {/* ── Stage legend ─────────────────────────────────────────────── */}
          <div className="stage-legend">
            {Object.entries(STAGE_COLOR).map(([stage, color]) => (
              <span key={stage} className="legend-item">
                <span className="legend-dot" style={{ background: color }} />
                {stage === 'R' ? 'REM' : stage}
              </span>
            ))}
            <span className="legend-item">
              <span className="legend-dot" style={{ background: 'rgba(0,0,0,0.06)', border: '1px solid #ced4da' }} />
              Apnea epoch
            </span>
          </div>

        </main>
      )}

      {!loading && !error && epochs.length === 0 && selected && (
        <div className="empty-state">No data available for {selected}</div>
      )}
    </div>
  );
}
