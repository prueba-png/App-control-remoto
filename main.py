"""Punto de entrada de VozDual.

    python main.py                 abre la aplicación
    python main.py --dispositivos  lista los dispositivos de audio y sale
"""

import logging
import sys


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if "--dispositivos" in sys.argv:
        from vozdual import audio_devices as ad

        for d in ad.list_devices():
            kind = ("E" if d.max_in else "-") + ("S" if d.max_out else "-")
            print(f"{d.index:3d} [{kind}] {d.label}  ({d.samplerate} Hz)")
        return
    from vozdual.gui import run

    run()


if __name__ == "__main__":
    main()
