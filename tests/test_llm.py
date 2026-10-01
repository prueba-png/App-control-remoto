import json
from types import SimpleNamespace

from vozdual.llm import SalesBrain, build_system_prompt, load_script, opening_line, split_sentences


class FakeStream:
    def __init__(self, chunks, stop_reason="end_turn"):
        self.chunks = chunks
        self.final = SimpleNamespace(
            stop_reason=stop_reason,
            content=[SimpleNamespace(type="text", text="".join(chunks))],
        )

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    @property
    def text_stream(self):
        yield from self.chunks

    def get_final_message(self):
        return self.final


class FakeClient:
    def __init__(self, *streams):
        self.streams = list(streams)
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kw):
        self.calls.append(kw)
        return self.streams.pop(0)


def test_split_sentences_keeps_remainder():
    done, rest = split_sentences("Hola, ¿qué tal? Le llamo por la web. Y ade")
    assert done == ["Hola, ¿qué tal?", "Le llamo por la web."]
    assert rest == "Y ade"


def test_opening_always_discloses_ai():
    assert "inteligencia artificial" in opening_line({"apertura": "Hola, ¿tiene un minuto?"}, "ACME")
    own = "Hola, soy el asistente virtual de ACME."
    assert opening_line({"apertura": own}) == own
    assert "ACME" in opening_line({}, "ACME")


def test_load_script_txt_and_json(tmp_path):
    t = tmp_path / "g.txt"
    t.write_text("Vende placas.", encoding="utf-8")
    assert load_script(t) == {"guion": "Vende placas."}
    j = tmp_path / "g.json"
    j.write_text(json.dumps({"empresa": "X", "pasos": ["a"]}), encoding="utf-8")
    assert load_script(j)["empresa"] == "X"
    assert "Vende placas." in build_system_prompt(load_script(t))


def test_reply_streams_sentences_and_keeps_history():
    client = FakeClient(FakeStream(["Perfecto. ", "¿Qué día le ", "viene bien?"]))
    brain = SalesBrain({"empresa": "X"}, client=client)
    out = list(brain.reply("Sí, me interesa"))
    assert out == ["Perfecto.", "¿Qué día le viene bien?"]
    call = client.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in call["betas"]
    assert call["output_config"] == {"effort": "low"}
    assert [m["role"] for m in brain.messages] == ["user", "assistant"]


def test_end_token_finishes_and_is_not_spoken():
    brain = SalesBrain({}, client=FakeClient(FakeStream(["Gracias, que tenga buen día. [FIN]"])))
    assert list(brain.reply("No me interesa")) == ["Gracias, que tenga buen día."]
    assert brain.finished


def test_refusal_gives_polite_answer():
    brain = SalesBrain({}, client=FakeClient(FakeStream([], stop_reason="refusal")))
    out = list(brain.reply("..."))
    assert out and "persona del equipo" in out[-1]
