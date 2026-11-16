import { cookKit } from "./cook.js";
import type { ICookRequest } from "./cook.js";

// The parent validated every field; the child still refuses a request that is not a plain object.
const request: unknown = JSON.parse(process.argv[2] ?? "null");
if (typeof request !== "object" || request === null) {
  throw new Error("cook-child: the request must be a JSON object.");
}

// The parent reads this single JSON line as the tool result.
console.log(await cookKit(request as ICookRequest));
