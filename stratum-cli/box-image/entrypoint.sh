#!/bin/sh
# Proceso principal de la caja: el escritorio virtual y nada más. Los comandos
# del agente llegan con `<runtime> exec`, no por aquí.
set -eu
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
exec sleep infinity
