// Where the activity glance is opened from, shared across the shell.
//
// The drawer itself is rendered by the workspace surface (it needs the feed, the
// members and the file list), but the control that opens it lives in the
// sidebar's footer — a different component tree entirely. One flag in shared
// state joins the two, rather than plumbing an event through the layout.
//
// `registerGlanceHost` is how the sidebar knows whether there is anything to
// open: surfaces that can render the drawer register themselves for as long as
// they are mounted. On a surface that can't (the full activity page, the
// dashboard) the sidebar navigates to /activity instead of setting a flag that
// nothing is listening to.
export function useActivityUi() {
  const open = useState<boolean>("th:activity-open", () => false);
  const hosts = useState<number>("th:activity-hosts", () => 0);

  /** Declare that this component renders the glance drawer while it is mounted. */
  function registerGlanceHost() {
    hosts.value += 1;
    onScopeDispose(() => {
      hosts.value -= 1;
      // Leaving the last host with the drawer "open" would reopen it on return.
      if (hosts.value <= 0) open.value = false;
    });
  }

  return { open, canGlance: computed(() => hosts.value > 0), registerGlanceHost };
}