/**
 * ============================
 * PATCH SHADOW DOM (Fixed)
 * ============================
 */
(function() {
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init) {

    // Intercept only the autocomplete component
    if (this.localName === "gmp-place-autocomplete") {

      // Force the shadow DOM to be "open"
      const shadow = originalAttachShadow.call(this, { ...init, mode: "open" });
      
      // Inject custom height and styling
      const style = document.createElement("style");
      style.textContent = `
        /* Targeting the internal container for the search bar */
        .input-container {
          height: 32px !important;
          display: flex;
          align-items: center;
          min-height: 32px !important; /* Ensure min-height doesn't block reduction */
        }
          
        input {
          height: 100% !important;
          font-size: 1rem !important;
          padding: 0 8px !important; /* Adjust padding for smaller height */
        }
      `;
      shadow.appendChild(style);
      return shadow;
    }
    return originalAttachShadow.call(this, init);
  };
})();
