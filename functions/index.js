"use strict";

const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

initializeApp();
const db = getFirestore();

const ALLOWED_ORIGIN = "https://agentvitahelm-bit.github.io";

function optionsForDates(dates) {
  return dates.flatMap(([weekday, month, day]) => [
    `${weekday}, ${month} ${day}, 2026 - 9:30 AM MT start`,
    `${weekday}, ${month} ${day}, 2026 - 1:00 PM MT start`,
  ]);
}

const THOMAS_OPTIONS = optionsForDates([
  ["Monday", "August", 17],
  ["Tuesday", "August", 18],
  ["Wednesday", "August", 19],
  ["Thursday", "August", 20],
  ["Friday", "August", 21],
  ["Monday", "August", 24],
  ["Tuesday", "August", 25],
  ["Wednesday", "August", 26],
  ["Thursday", "August", 27],
  ["Friday", "August", 28],
  ["Monday", "August", 31],
]);

const THOMAS_ROUND2_OPTIONS = optionsForDates([
  ["Wednesday", "August", 12],
  ["Thursday", "August", 13],
  ["Friday", "August", 14],
  ["Monday", "August", 31],
  ["Tuesday", "September", 1],
  ["Wednesday", "September", 2],
  ["Thursday", "September", 3],
  ["Friday", "September", 4],
  ["Monday", "September", 28],
  ["Tuesday", "September", 29],
  ["Wednesday", "September", 30],
  ["Thursday", "October", 1],
  ["Friday", "October", 2],
]);

const MUHAMMAD_OPTIONS = [
  "Friday, August 28, 2026 - 9:30 AM MT start",
  ...optionsForDates([
    ["Thursday", "October", 1],
    ["Friday", "October", 2],
    ["Monday", "October", 5],
    ["Tuesday", "October", 6],
    ["Wednesday", "October", 7],
    ["Thursday", "October", 8],
    ["Friday", "October", 9],
    ["Tuesday", "October", 13],
    ["Wednesday", "October", 14],
  ]),
];

const POLLS = new Map([
  ["thomas-oldreive-msc-defense-2026-08-7f3c9a", new Set(THOMAS_OPTIONS)],
  ["thomas-oldreive-msc-defense-round2-2026-aug-sep-cfca2d", new Set(THOMAS_ROUND2_OPTIONS)],
  ["muhammad-mahajna-stage1-2026-aug-oct-63ec5a", new Set(MUHAMMAD_OPTIONS)],
]);

function setCors(req, res) {
  const origin = req.get("origin");
  if (origin === ALLOWED_ORIGIN) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.set("Cache-Control", "no-store");
  return !origin || origin === ALLOWED_ORIGIN;
}

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}

function participantId(name) {
  return crypto.createHash("sha256").update(name.toLocaleLowerCase("en-CA")).digest("hex").slice(0, 32);
}

function validateSelections(value, allowedOptions) {
  if (!Array.isArray(value) || value.length > allowedOptions.size) return null;
  if (!value.every((item) => typeof item === "string" && allowedOptions.has(item))) return null;
  return [...new Set(value)];
}

async function listResponses(pollId, allowedOptions) {
  const snapshot = await db.collection("traineePolls").doc(pollId).collection("responses").get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        name: typeof data.name === "string" ? data.name : "Participant",
        selections: Array.isArray(data.selections) ? data.selections.filter((item) => allowedOptions.has(item)) : [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

exports.traineePollApi = onRequest(
  { region: "us-central1", timeoutSeconds: 30, memory: "256MiB", maxInstances: 5 },
  async (req, res) => {
    if (!setCors(req, res)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const pollId = req.method === "GET" ? req.query.pollId : req.body && req.body.pollId;
    const allowedOptions = POLLS.get(pollId);
    if (!allowedOptions) {
      res.status(404).json({ error: "Poll not found" });
      return;
    }

    try {
      if (req.method === "GET") {
        res.status(200).json({ pollId, responses: await listResponses(pollId, allowedOptions) });
        return;
      }
      if (req.method !== "POST") {
        res.set("Allow", "GET, POST, OPTIONS");
        res.status(405).json({ error: "Method not allowed" });
        return;
      }

      const name = normalizeName(req.body && req.body.name);
      const selections = validateSelections(req.body && req.body.selections, allowedOptions);
      if (!name) {
        res.status(400).json({ error: "Enter a valid name (1-80 characters)." });
        return;
      }
      if (selections === null) {
        res.status(400).json({ error: "The availability selection is invalid." });
        return;
      }

      const id = participantId(name);
      await db.collection("traineePolls").doc(pollId).collection("responses").doc(id).set(
        { name, nameNormalized: name.toLocaleLowerCase("en-CA"), selections, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      logger.info("Trainee poll response saved", { pollId, participantId: id, selectionCount: selections.length });
      res.status(200).json({ pollId, saved: true, responses: await listResponses(pollId, allowedOptions) });
    } catch (error) {
      logger.error("Trainee poll request failed", { pollId, error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "The poll service could not complete the request." });
    }
  },
);
