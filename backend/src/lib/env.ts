import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..", "..");
const envPath = path.join(backendRoot, ".env");

const result = dotenv.config({ path: envPath });
if (result.error && !fs.existsSync(envPath)) {
  dotenv.config();
}
