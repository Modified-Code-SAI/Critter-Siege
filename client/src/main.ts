import { GAME_TITLE } from "@critter/shared";

export function renderTitleCheck(root: HTMLElement | null): void {
  if (!root) {
    return;
  }
  const heading = document.createElement("h1");
  heading.textContent = GAME_TITLE;
  root.replaceChildren(heading);
}

renderTitleCheck(document.getElementById("app"));
