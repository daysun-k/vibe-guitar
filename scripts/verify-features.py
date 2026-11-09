# Optional parity check for src/audio/features.ts against librosa's CQT (BTC input).
# Run: uv run --with librosa==0.10.2.post1 --with numpy python scripts/verify-features.py
# Writes bench-out/cqt-parity.json; tests/features.test.ts compares when the file exists.
import json, os
import numpy as np
import librosa

sr = 22050
rng = np.random.default_rng(7)
t = np.arange(int(sr * 12)) / sr
x = np.zeros_like(t)
# C major then A minor then G7, piano-like decaying partials, plus light noise
for start, notes in [(0, [48, 52, 55, 60]), (4, [45, 52, 57, 60]), (8, [43, 50, 53, 59])]:
    seg = (t >= start) & (t < start + 4)
    for n in notes:
        f = 440 * 2 ** ((n - 69) / 12)
        for h in range(1, 6):
            x[seg] += 0.08 / h * np.sin(2 * np.pi * f * h * (t[seg] - start)) * np.exp(-(t[seg] - start) * 0.7)
x += 0.003 * rng.standard_normal(len(x))
x = x.astype(np.float32)
C = librosa.cqt(x, sr=sr, n_bins=144, bins_per_octave=24, hop_length=2048, fmin=librosa.note_to_hz('C1'), pad_mode='reflect')
logC = np.log(np.abs(C) + 1e-6)
os.makedirs('bench-out', exist_ok=True)
with open('bench-out/cqt-parity.json', 'w') as f:
    json.dump({'librosa': librosa.__version__, 'signal': x.tolist(), 'frames': logC.shape[1], 'logcqt': logC.T.flatten().tolist()}, f)
print('librosa', librosa.__version__, 'frames', logC.shape[1], 'mean', float(logC.mean()))
