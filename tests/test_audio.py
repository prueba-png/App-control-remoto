import numpy as np
import pytest

from vozdual.converters import PassthroughConverter, PitchFormantConverter, RVCOnnxConverter
from vozdual.dsp import EnergyVAD, Sola, yin_f0
from vozdual.realtime import BlockProcessor, RingBuffer


def tone(f, sr, seconds, amp=0.4):
    t = np.arange(int(sr * seconds)) / sr
    return (amp * np.sin(2 * np.pi * f * t) + 0.3 * amp * np.sin(4 * np.pi * f * t)).astype(np.float32)


@pytest.mark.parametrize("f", [90.0, 180.0, 440.0])
def test_yin_detects_pitch(f):
    f0 = yin_f0(tone(f, 16000, 0.5), 16000, 160)
    assert abs(np.median(f0[5:-5]) - f) < 1.0


@pytest.mark.parametrize("semitones", [-5, 0, 7])
def test_pitch_converter_shifts_by_semitones(semitones):
    sr = 24000
    x = tone(150, sr, 1.5)
    conv = PitchFormantConverter(semitones=semitones, sr=sr)
    y = np.concatenate([conv.process(x[i : i + 3333]) for i in range(0, len(x), 3333)])
    assert len(y) == len(x)  # misma duración aunque el bloque no sea múltiplo del hop
    f0 = yin_f0(y, sr, 240)
    assert abs(np.median(f0[20:-5]) - 150 * 2 ** (semitones / 12)) < 2.0


def test_sola_output_length_and_continuity():
    sola = Sola(crossfade=200, search=100)
    sig = tone(200, 16000, 1.0)
    out = []
    pos = 0
    L = 1600
    while pos + L + 300 <= len(sig):
        # Cada trozo empieza "crossfade+search" antes del final del anterior, como en RVC.
        out.append(sola.consume(sig[pos : pos + L + 300], L))
        pos += L
    y = np.concatenate(out)
    assert len(y) == L * len(out)
    assert np.max(np.abs(np.diff(y))) < 0.2  # sin clics


def test_vad_returns_one_utterance_per_phrase():
    sr = 16000
    silence = np.random.default_rng(0).normal(0, 0.001, sr).astype(np.float32)
    audio = np.concatenate([silence, tone(200, sr, 1.0), silence, tone(300, sr, 0.8), silence])
    vad = EnergyVAD(sr)
    utts = []
    for i in range(0, len(audio), 480):
        utts += vad.feed(audio[i : i + 480])
    assert len(utts) == 2
    assert 0.9 < len(utts[0]) / sr < 2.0


def test_ring_buffer_wraps_and_reports_missing():
    rb = RingBuffer(10)
    rb.write(np.arange(8, dtype=np.float32))
    a, missing = rb.read(5)
    assert missing == 0 and a.tolist() == [0, 1, 2, 3, 4]
    rb.write(np.arange(100, 106, dtype=np.float32))
    b, missing = rb.read(12)
    assert b[:9].tolist() == [5, 6, 7, 100, 101, 102, 103, 104, 105]
    assert missing == 3


@pytest.mark.parametrize("in_sr,out_sr", [(48000, 48000), (44100, 48000)])
def test_block_processor_keeps_realtime_rate(in_sr, out_sr):
    proc = BlockProcessor(PitchFormantConverter(semitones=3), in_sr, out_sr, block_ms=100, gate_db=-80)
    x = tone(200, in_sr, 3.0)
    total = sum(len(proc.feed(x[i : i + 960])) for i in range(0, len(x), 960))
    # Sale (casi) la misma duración que entra; solo queda el retraso del bloque y del resampler.
    assert abs(total / out_sr - 3.0) < 0.25


def test_noise_gate_silences_quiet_input():
    proc = BlockProcessor(PassthroughConverter(48000), 48000, 48000, block_ms=100, gate_db=-40)
    quiet = np.full(48000, 1e-4, dtype=np.float32)
    assert np.max(np.abs(proc.feed(quiet))) == 0.0


# ---------------------------------------------------------------- RVC ONNX
onnx = pytest.importorskip("onnx")
from onnx import TensorProto, helper  # noqa: E402


def _fake_contentvec(path):
    """[1,1,N] -> [1,T,768] con T = N/320, como ContentVec."""
    nodes = [
        helper.make_node("AveragePool", ["source"], ["p"], kernel_shape=[320], strides=[320]),
        helper.make_node("Expand", ["p", "shape"], ["e"]),
        helper.make_node("Transpose", ["e"], ["embed"], perm=[0, 2, 1]),
    ]
    g = helper.make_graph(
        nodes, "vec",
        [helper.make_tensor_value_info("source", TensorProto.FLOAT, [1, 1, None])],
        [helper.make_tensor_value_info("embed", TensorProto.FLOAT, [1, None, 768])],
        [helper.make_tensor("shape", TensorProto.INT64, [3], [1, 768, 1])],
    )
    onnx.save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], ir_version=8), path)


def _fake_rvc(path, hop=400):
    """Mismas entradas que el exportador de RVC; devuelve pitchf estirado a audio."""
    nodes = [
        helper.make_node("Unsqueeze", ["pitchf", "ax"], ["u"]),
        helper.make_node("Expand", ["u", "rep"], ["e"]),
        helper.make_node("Reshape", ["e", "flat"], ["r"]),
        helper.make_node("Mul", ["r", "scale"], ["audio"]),
    ]
    g = helper.make_graph(
        nodes, "rvc",
        [
            helper.make_tensor_value_info("phone", TensorProto.FLOAT, [1, None, 768]),
            helper.make_tensor_value_info("phone_lengths", TensorProto.INT64, [1]),
            helper.make_tensor_value_info("pitch", TensorProto.INT64, [1, None]),
            helper.make_tensor_value_info("pitchf", TensorProto.FLOAT, [1, None]),
            helper.make_tensor_value_info("ds", TensorProto.INT64, [1]),
            helper.make_tensor_value_info("rnd", TensorProto.FLOAT, [1, 192, None]),
        ],
        [helper.make_tensor_value_info("audio", TensorProto.FLOAT, [1, 1, None])],
        [
            helper.make_tensor("ax", TensorProto.INT64, [1], [2]),
            helper.make_tensor("rep", TensorProto.INT64, [3], [1, 1, hop]),
            helper.make_tensor("flat", TensorProto.INT64, [3], [1, 1, -1]),
            helper.make_tensor("scale", TensorProto.FLOAT, [], [0.001]),
        ],
    )
    onnx.save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], ir_version=8), path)


@pytest.fixture
def rvc(tmp_path):
    _fake_contentvec(tmp_path / "vec.onnx")
    _fake_rvc(tmp_path / "voz.onnx")
    return RVCOnnxConverter(tmp_path / "voz.onnx", tmp_path / "vec.onnx", output_sr=40000,
                            semitones=12, prefer_gpu=False)


def test_rvc_streaming_shapes_and_pitch(rvc):
    block = 3200  # 200 ms a 16 kHz
    x = tone(200, 16000, 1.0)
    y = rvc.process(x[:block], extra=500)
    assert len(y) == 8000 + 500
    # El modelo falso devuelve f0*0.001: +12 semitonos -> 400 Hz -> 0.4
    assert abs(np.median(y) - 0.4) < 0.02


def test_rvc_in_block_processor(rvc):
    proc = BlockProcessor(rvc, 48000, 48000, block_ms=200, gate_db=-80)
    x = tone(200, 48000, 2.0)
    out = np.concatenate([proc.feed(x[i : i + 960]) for i in range(0, len(x), 960)])
    assert abs(len(out) / 48000 - 2.0) < 0.3
    assert proc.last_infer_ms < 200


def test_rvc_offline_utterance(rvc):
    y, sr = rvc.convert_utterance(tone(220, 22050, 1.0), 22050)
    assert sr == 40000 and abs(len(y) / sr - 1.0) < 0.1


def test_coarse_pitch_range():
    c = RVCOnnxConverter.coarse_pitch(np.array([0.0, 50.0, 200.0, 1100.0, 3000.0]))
    assert c[0] == 1 and c[1] == 1 and 1 < c[2] < 255 and c[3] == 255 and c[4] == 255
