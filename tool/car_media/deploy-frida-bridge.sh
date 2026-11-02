#!/bin/sh
set -eu

DEVICE="${1:-frp.lynkco.love:31081}"
ROOT=/data/local/tmp/wyyyy_frida
ADB="adb -s $DEVICE"

# FRP ADB endpoints can disappear between the connect and the first shell
# request. Reconnect and poll briefly instead of blocking forever in wait-for-device.
if ! $ADB get-state >/dev/null 2>&1; then
  adb connect "$DEVICE" >/dev/null 2>&1 || true
fi
ready=0
for _ in 1 2 3 4 5 6 7 8; do
  if $ADB get-state >/dev/null 2>&1; then
    ready=1
    break
  fi
  adb connect "$DEVICE" >/dev/null 2>&1 || true
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "无法连接 ADB 设备 $DEVICE" >&2
  exit 1
fi
$ADB shell "mkdir -p $ROOT"
$ADB push android/app/src/main/assets/car_media/inject_xsf_session_bilisail.js "$ROOT/inject_xsf_session_bilisail.js" >/dev/null
$ADB push android/app/src/main/assets/car_media/inject_mediacontrol_bilisail.js "$ROOT/inject_mediacontrol_bilisail.js" >/dev/null
$ADB shell "chmod 755 $ROOT/inject_xsf_session_bilisail.js $ROOT/inject_mediacontrol_bilisail.js"

inject() {
  process="$1"
  script="$2"
  log="$3"
  pid="$($ADB shell "pidof $process" 2>/dev/null | tr -d '\r' | tr ' ' '\n' | sed -n '1p')"
  if [ -z "$pid" ]; then
    echo "未找到进程 $process；请先让车机媒体中心运行。" >&2
    return 1
  fi
  echo "注入 $process pid=$pid script=$script"
  $ADB shell "$ROOT/frida-inject -p $pid -s $ROOT/$script >$ROOT/$log 2>&1 &"
}

inject ecarx.xsf.mediacenter inject_xsf_session_bilisail.js inject_xsf_session_bilisail.log
inject com.flyme.auto.mediacontrol inject_mediacontrol_bilisail.js inject_mediacontrol_bilisail.log

echo "注入完成；日志目录：$ROOT"
