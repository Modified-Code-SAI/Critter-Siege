import { GAME_TITLE } from "@critter/shared";

export function getServerBanner(): string {
  return `${GAME_TITLE} Server Ready`;
}

if (process.env.NODE_ENV !== "test") {
  console.log(getServerBanner());
}
