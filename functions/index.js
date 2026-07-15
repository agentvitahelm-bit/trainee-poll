"use strict";

const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

initializeApp();
const db = getFirestore();

const ALLOWED_ORIGIN = "https://agentvitahelm-bit.github.io";
const POLL_ID = "thomas-oldreive-msc-defense-2026-08-7f3c9a";
const DATES = [
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
];
const ALLOWED_OPTIONS = new Set(
  DATES.flatMap(([weekday, month, day]) => [
    `${weekday}, ${month} ${day}, 2026 - 9:30 AM MT start`,
    `${weekday}, ${month} ${day}, 2026 - 1:00 PM MT start`,
  ]),
);

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

function validateSelections(value) {
  if (!Array.isArray(value) || value.length > ALLOWED_OPTIONS.size) return null;
  if (!value.every((item) => typeof item === "string" && ALLOWED_OPTIONS.has(item))) return null;
  return [...new Set(value)];
}

async function listResponses() {
  const snapshot = await db.collection("traineePolls").doc(POLL_ID).collection("responses").get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        name: typeof data.name === "string" ? data.name : "Participant",
        selections: Array.isArray(data.selections) ? data.selections.filter((item) => ALLOWED_OPTIONS.has(item)) : [],
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
    if (pollId !== POLL_ID) {
      res.status(404).json({ error: "Poll not found" });
      return;
    }

    try {
      if (req.method === "GET") {
        res.status(200).json({ pollId: POLL_ID, responses: await listResponses() });
        return;
      }
      if (req.method !== "POST") {
        res.set("Allow", "GET, POST, OPTIONS");
        res.status(405).json({ error: "Method not allowed" });
        return;
      }

      const name = normalizeName(req.body && req.body.name);
      const selections = validateSelections(req.body && req.body.selections);
      if (!name) {
        res.status(400).json({ error: "Enter a valid name (1-80 characters)." });
        return;
      }
      if (selections === null) {
        res.status(400).json({ error: "The availability selection is invalid." });
        return;
      }

      const id = participantId(name);
      await db.collection("traineePolls").doc(POLL_ID).collection("responses").doc(id).set(
        { name, nameNormalized: name.toLocaleLowerCase("en-CA"), selections, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      logger.info("Trainee poll response saved", { pollId: POLL_ID, participantId: id, selectionCount: selections.length });
      res.status(200).json({ pollId: POLL_ID, saved: true, responses: await listResponses() });
    } catch (error) {
      logger.error("Trainee poll request failed", { pollId: POLL_ID, error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "The poll service could not complete the request." });
    }
  },
);
