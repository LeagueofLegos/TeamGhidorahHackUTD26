import { cli, httpOrigin, database } from "./cli.js";
const identity = process.argv[2];
if (!/^[0-9a-f]{64}$/i.test(identity ?? ""))
  throw new Error("Expected a SpacetimeDB identity");
// Invoked only by the loopback Vite development server or explicitly by the publisher.
cli([
  "call",
  "--server",
  httpOrigin,
  database,
  "grant_writer",
  JSON.stringify(identity),
  "true",
]);
