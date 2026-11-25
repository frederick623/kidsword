import "./styles.css";
import { GameService } from "./services/gameService";
import { PreferencesStore } from "./services/storage";
import { App } from "./ui/app";

const app = new App(new GameService(new PreferencesStore()));
app.start().catch((err: unknown) => {
  console.error(err);
  const t = document.getElementById("toast");
  if (t) {
    t.textContent = "Oops! Something went wrong. Please restart the app.";
    t.classList.add("show");
  }
});
