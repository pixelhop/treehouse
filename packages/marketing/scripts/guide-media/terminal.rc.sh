# Sourced (hidden) at the start of each tape. A throwaway HOME and TREEHOUSE_HOME
# keep the recording away from your own synced folders and daemon.
export HOME="$GUIDE_MEDIA_HOME" TREEHOUSE_HOME="$GUIDE_MEDIA_HOME/.treehouse" PS1='$ '
treehouse() { node "$REPO/packages/cli/bin/treehouse.mjs" "$@"; }
cd ~ && clear
