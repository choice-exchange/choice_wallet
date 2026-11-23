// The offscreen page the worker opens to take a copied key off the clipboard (a worker has no
// clipboard of its own). It copies nothing over what is there, then tells the worker, which
// closes it.

const area = document.getElementById("clear") as HTMLTextAreaElement | null;
document.addEventListener("copy", (e) => {
  e.clipboardData?.setData("text/plain", "");
  e.preventDefault();
});
if (area) {
  area.value = " ";
  area.select();
}
document.execCommand("copy");
void chrome.runtime.sendMessage({ choice: "clipboard_cleared" }).catch(() => {});
