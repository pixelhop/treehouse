/**
 * Open and close behaviour for a dropdown: a click outside `root` or Escape
 * closes it, and Escape hands focus back to `trigger`. Bind `onKeydown` on the
 * root element, and `root` and `trigger` as template refs.
 */
export function useDismissible() {
  const open = ref(false);
  const root = ref<HTMLElement | null>(null);
  const trigger = ref<HTMLButtonElement | null>(null);

  function close() {
    open.value = false;
  }

  function onDocumentClick(event: MouseEvent) {
    if (open.value && root.value && !root.value.contains(event.target as Node)) close();
  }
  onMounted(() => document.addEventListener("click", onDocumentClick));
  onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && open.value) {
      close();
      trigger.value?.focus();
    }
  }

  return { open, root, trigger, close, onKeydown };
}