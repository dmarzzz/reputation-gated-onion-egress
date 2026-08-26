/* global document, window */

if (window.location.protocol === "file:") {
  const setText = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  };

  const showLocalPreview = () => {
    document.body.classList.add("is-local-preview");

    setText("[data-snapshot-state]", "Local preview");
    setText("[data-network]", "Sepolia");
    setText("[data-view-time]", "Not connected");
    setText("[data-snapshot-cadence]", "15 min");
    setText("[data-node-count]", "—");
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showLocalPreview, { once: true });
  } else {
    showLocalPreview();
  }
}
