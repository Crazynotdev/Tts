const express = require("express");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// ========== Config ==========
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: "*" });
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SESSIONS_DIR = path.join(__dirname, "sessions");
const SEEN_JIDS_FILE = path.join(__dirname, "seen_jids.json");

if (!fs.existsSync(SEEN_JIDS_FILE)) fs.writeFileSync(SEEN_JIDS_FILE, JSON.stringify([]));

let sessions = {}; // sessions WhatsApp actives

// ========== Démarrer une session ==========
async function startSession(number, socketClientId) {
  const sessionId = number.replace(/\D/g, "");
  const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, sessionId));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["CRAZY MINI XMD", "Chrome", "1.0"],
  });

  sessions[sessionId] = { sock, saveCreds, socketClientId };

  // ========== Connection update ==========
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, pairingCode } = update;

    if (pairingCode) {
      io.to(socketClientId).emit("pairing_code", { code: pairingCode, rawCode: pairingCode });
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) startSession(number, socketClientId);
      else console.log("Session supprimée pour", number);
    }

    if (connection === "open") {
      io.to(socketClientId).emit("connection_success", { number });
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ========== Messages reçus ==========
  sock.ev.on("messages.upsert", (m) => {
    const messages = m.messages;
    const seenJids = JSON.parse(fs.readFileSync(SEEN_JIDS_FILE));

    messages.forEach((msg) => {
      const jid = msg.key.remoteJid;
      if (!seenJids.includes(jid)) {
        seenJids.push(jid);
        fs.writeFileSync(SEEN_JIDS_FILE, JSON.stringify(seenJids, null, 2));
      }

      if (!msg.message || msg.key.fromMe) return;

      let body = msg.message.conversation || msg.message?.extendedTextMessage?.text || "";
      if (!body.startsWith(".")) return;

      const args = body.slice(1).trim().split(/ +/);
      const command = args[0].toLowerCase();

      // ======= SWITCH CASE COMMANDES =======
      switch (command) {
        case "menu":
          sock.sendMessage(jid, {
            text: "✅ Commandes disponibles :\n.menu\n.ping\n.hello",
          });
          break;

        case "ping":
          sock.sendMessage(jid, { text: "🏓 Pong!" });
          break;

        case "hello":
          sock.sendMessage(jid, { text: `Hello ${msg.pushName || "user"}! 👋` });
          break;

        default:
          sock.sendMessage(jid, { text: "❌ Commande inconnue" });
          break;
      }
    });
  });

  // Obtenir pairing code réel
  const code = await sock.requestPairingCode(number);
  io.to(socketClientId).emit("pairing_code", { code, rawCode: code });

  return sessionId;
}

// ========== API HTTP ==========
app.post("/api/connect", async (req, res) => {
  const number = req.body.number;
  const socketClientId = req.body.socketId;
  if (!number) return res.status(400).json({ error: "Numéro manquant" });

  await startSession(number, socketClientId);
  res.json({ success: true });
});

// ========== Socket.IO ==========
io.on("connection", (socket) => {
  socket.on("join_session", (id) => socket.join(id));
});

// ========== Serveur front ==========
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ========== Lancer serveur ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`));
