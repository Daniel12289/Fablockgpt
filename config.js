/* FABLOCK AI BUILDER PRO - frontend configuration.
   Only the PUBLIC address of the backend lives here. The Groq API key is stored
   on the backend (Floot env var GROQ_API_KEY) and is never sent to the browser. */
window.FABLOCK_CONFIG = {
  API: "https://fablockgpt.floot.app/_api"
};
