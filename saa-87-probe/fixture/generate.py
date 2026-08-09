#!/usr/bin/env python3
"""
Fixed source for SAA-87 state-2 (granted) and state-3 (denied) runs.

Sine wave, mono, 48 kHz, 32-bit float WAV.
Default: 1000 Hz, amplitude 0.5 peak, 15 s.

Predicted captured RMS: source RMS = amplitude / sqrt(2).
At 100% system output volume, captured RMS should be within measurement
noise of the source RMS regardless of whether Core Audio taps see the
signal pre- or post-volume — that question isn't established for this
API, and pinning volume at unity is what makes it not matter. A large
mismatch between predicted and observed at 100% volume is therefore a
finding, not a puzzle.

To reduce loudness during runs, drop AMPLITUDE to 0.1 (predicted RMS
~0.0707, still ~1400x the noise floor observed on the 08-04 spike).
"""

import array
import math
import struct
from pathlib import Path

FREQ_HZ = 1000.0
AMPLITUDE = 0.5      # peak, fraction of full scale
DURATION_S = 15.0
SAMPLE_RATE = 48000
CHANNELS = 1
OUT_PATH = Path(__file__).parent / f'source-{int(FREQ_HZ)}hz-amp{AMPLITUDE}-{int(DURATION_S)}s-{SAMPLE_RATE//1000}kHz.wav'

n_samples = int(DURATION_S * SAMPLE_RATE)
samples = array.array('f')
w = 2.0 * math.pi * FREQ_HZ / SAMPLE_RATE
for i in range(n_samples):
    samples.append(AMPLITUDE * math.sin(w * i))

data_bytes = samples.tobytes()
data_size = len(data_bytes)
fmt_size = 16
fact_size = 4
riff_size = 4 + (8 + fmt_size) + (8 + fact_size) + (8 + data_size)

with OUT_PATH.open('wb') as f:
    f.write(b'RIFF')
    f.write(struct.pack('<I', riff_size))
    f.write(b'WAVE')
    f.write(b'fmt ')
    f.write(struct.pack('<I', fmt_size))
    # AudioFormat = 3 (IEEE float), channels, rate, byte-rate, block-align, bits
    byte_rate = SAMPLE_RATE * 4 * CHANNELS
    block_align = 4 * CHANNELS
    f.write(struct.pack('<HHIIHH', 3, CHANNELS, SAMPLE_RATE, byte_rate, block_align, 32))
    f.write(b'fact')
    f.write(struct.pack('<I', fact_size))
    f.write(struct.pack('<I', n_samples))
    f.write(b'data')
    f.write(struct.pack('<I', data_size))
    f.write(data_bytes)


def _read_wav_data_chunk(path):
    """Reopen the file, walk RIFF chunks, return the 'data' chunk bytes."""
    with open(path, 'rb') as f:
        head = f.read(12)
        if head[:4] != b'RIFF' or head[8:12] != b'WAVE':
            raise ValueError(f'not a RIFF/WAVE file: {path}')
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                raise ValueError(f'data chunk not found in {path}')
            cid, csize = struct.unpack('<4sI', hdr)
            if cid == b'data':
                buf = f.read(csize)
                if len(buf) != csize:
                    raise ValueError(f'short read on data chunk: got {len(buf)} expected {csize}')
                return buf
            f.seek(csize, 1)


data_read = _read_wav_data_chunk(OUT_PATH)
n_read = len(data_read) // 4
floats_read = struct.unpack(f'<{n_read}f', data_read)
ss_read = 0.0
for x in floats_read:
    ss_read += x * x
readback_rms = (ss_read / n_read) ** 0.5
predicted_rms = AMPLITUDE / math.sqrt(2.0)

print(f'wrote:              {OUT_PATH}')
print(f'bytes:              {OUT_PATH.stat().st_size}')
print(f'samples (written):  {n_samples}')
print(f'samples (readback): {n_read}')
print(f'duration:           {DURATION_S} s')
print(f'rate:               {SAMPLE_RATE} Hz')
print(f'channels:           {CHANNELS}')
print(f'format:             32-bit float WAV (IEEE)')
print(f'freq:               {FREQ_HZ} Hz')
print(f'amplitude:          {AMPLITUDE} (peak, fraction of full scale)')
print(f'predicted RMS:      {predicted_rms:.7f}')
print(f'readback RMS:       {readback_rms:.7f}   (computed from re-read file, not in-memory)')
