// jsdom does not implement the native dialog top layer. Real keyboard and focus
// behavior is exercised in Electron; these tests drive the same dialog buttons.
export function installDialogMethods() {
  HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  HTMLDialogElement.prototype.close ??= function () { this.open = false; };
}
