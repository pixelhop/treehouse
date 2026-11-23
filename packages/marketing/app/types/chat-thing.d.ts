/** The globals the Chat Thing widget script reads and defines. */
interface Window {
  /** Read by the widget script when it loads; see ChatLauncher.client.vue. */
  chatThingConfig?: Record<string, unknown>;
  /** The widget's SDK, defined by the script as soon as it runs. */
  chatThing?: { show: () => void };
}