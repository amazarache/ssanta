// Writes the play guide to stdout. Run from server/: bun run guide > ../santa/guide.md
import { playGuide } from "./prompts.ts";

process.stdout.write(playGuide());
