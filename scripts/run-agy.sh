#!/bin/sh
set -eu
# The agy login may live in a keyring on this user's session bus; sudo drops the environment that points at it.
if [ -S "/run/user/$(id -u)/bus" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
fi
# sudo may leave HOME pointing at the caller; agy keeps its login and state under the agy user's home.
HOME=$(getent passwd "$(id -un)" | cut -d: -f6)
export HOME
exec "$HOME/.local/bin/agy" "$@"
