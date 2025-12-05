import express from "express";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: "*" });

app.use(cors());
app.use(express.json());

let sessions = {}; // stocker sockets et bots

async function startSession(number, socketClientId) {
    const sessionId = number.replace(/\D/g, "");

    // Auth files pour ce numéro
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);

    // Version recommandée
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
        browser: ["CRAZY MINI XMD", "Chrome", "1.0"]
    });

    sessions[sessionId] = { sock, saveCreds, socketClientId };

    // ⚡ Quand WhatsApp demande un pairing code
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, pairingCode } = update;

        if (pairingCode) {
            // envoyer au bon client
            io.to(socketClientId).emit("pairing_code", {
                code: pairingCode,
                rawCode: pairingCode
            });
        }

        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

            if (reason !== DisconnectReason.loggedOut) {
                startSession(number, socketClientId);
            } else {
                console.log("Session supprimée");
            }
        }

        if (connection === "open") {
            io.to(socketClientId).emit("connection_success", {
                number
            });
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // Obtenir pairing code réel
    const code = await sock.requestPairingCode(number);
    io.to(socketClientId).emit("pairing_code", {
        code,
        rawCode: code
    });

    return sessionId;
}

// =========================
//     API HTTP
// =========================

app.get("/code", async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: "Numéro manquant" });

    try {
        return res.json({ code: "Waiting with Socket.IO…" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.post("/api/connect", async (req, res) => {
    const number = req.body.number;
    const socketClientId = req.body.socketId;

    if (!number) return res.status(400).json({ error: "Numéro manquant" });

    await startSession(number, socketClientId);
    res.json({ success: true });
});

// =========================
//   Socket.IO
// =========================

io.on("connection", (socket) => {
    socket.on("join_session", (id) => {
        socket.join(id);
    });
});

server.listen(3000, () => {
    console.log("🚀 Serveur prêt sur http://localhost:3000");
});
