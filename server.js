const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// TENTO ENDPOINT UDRŽÍ SERVER NAŽIVU PŘES CRON-JOB.ORG
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

const db = new sqlite3.Database('./neo_survivor.db', (err) => {
    if (err) {
        console.error("Chyba při připojování k databázi:", err.message);
    } else {
        console.log("Připojeno k SQLite databázi.");
        db.run(`CREATE TABLE IF NOT EXISTS accounts (
            username TEXT PRIMARY KEY,
            password TEXT,
            meta TEXT,
            max_level INTEGER
        )`);
    }
});

const ROOMS = {};

const CONFIG = {
    ENEMY_BASE_HEALTH: 20,
    ENEMY_BASE_SPEED: 4.5, 
    SPAWN_INTERVAL: 800,
    BOSS_INTERVAL: 60
};

function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

function broadcastLeaderboard() {
    db.all(`SELECT username as name, max_level as level FROM accounts ORDER BY max_level DESC LIMIT 10`, [], (err, rows) => {
        if (!err && rows) {
            io.emit('leaderboardData', rows);
        }
    });
}

io.on('connection', (socket) => {
    console.log('Hráč připojen:', socket.id);

    socket.on('register', (data) => {
        const { user, pass } = data;
        if (!user || user.length < 3 || !pass || pass.length < 1) {
            return socket.emit('registerResponse', { success: false, msg: 'Jméno min. 3 znaky a heslo nesmí být prázdné.' });
        }
        
        db.get(`SELECT username FROM accounts WHERE username = ?`, [user], (err, row) => {
            if (row) {
                return socket.emit('registerResponse', { success: false, msg: 'Toto jméno už někdo používá.' });
            }
            
            const defaultMeta = {
                playerName: user,
                maxLevel: 1,
                currency: 0,
                upgrades: { hp: 0, speed: 0, luck: 0, hat: null },
                ships: { 1: true, 2: false, 3: false },
                selectedShip: 1,
                abilities: { 1: true, 2: false, 3: false },
                selectedAbility: 1
            };
            
            db.run(`INSERT INTO accounts (username, password, meta, max_level) VALUES (?, ?, ?, ?)`, 
                [user, pass, JSON.stringify(defaultMeta), 1], 
                (err) => {
                    if (err) {
                        return socket.emit('registerResponse', { success: false, msg: 'Chyba při zápisu do databáze.' });
                    }
                    socket.emit('registerResponse', { success: true, meta: defaultMeta });
                    broadcastLeaderboard();
            });
        });
    });

    socket.on('login', (data) => {
        const { user, pass } = data;
        db.get(`SELECT meta FROM accounts WHERE username = ? AND password = ?`, [user, pass], (err, row) => {
            if (row) {
                const parsedMeta = JSON.parse(row.meta);
                if (!parsedMeta.abilities) parsedMeta.abilities = { 1: true, 2: false, 3: false };
                if (!parsedMeta.selectedAbility) parsedMeta.selectedAbility = 1;
                socket.emit('loginResponse', { success: true, meta: parsedMeta });
            } else {
                socket.emit('loginResponse', { success: false, msg: 'Špatné jméno nebo heslo.' });
            }
        });
    });

    socket.on('syncAccount', (data) => {
        const { user, pass, meta } = data;
        db.get(`SELECT password, max_level FROM accounts WHERE username = ?`, [user], (err, row) => {
            if (row && row.password === pass) {
                const newMaxLevel = Math.max(meta.maxLevel || 1, row.max_level || 1);
                db.run(`UPDATE accounts SET meta = ?, max_level = ? WHERE username = ?`, 
                    [JSON.stringify(meta), newMaxLevel, user], 
                    (err) => {
                        if (!err && newMaxLevel > row.max_level) {
                            broadcastLeaderboard();
                        }
                });
            }
        });
    });

    socket.on('requestLeaderboard', () => {
        broadcastLeaderboard();
    });

    socket.on('submitScore', (data) => {
        if (data && data.name && data.level) {
            db.get(`SELECT max_level FROM accounts WHERE username = ?`, [data.name], (err, row) => {
                if (row && data.level > row.max_level) {
                    db.run(`UPDATE accounts SET max_level = ? WHERE username = ?`, [data.level, data.name], () => {
                        broadcastLeaderboard();
                    });
                }
            });
        }
    });

    socket.on('requestRooms', () => {
        const activeRooms = [];
        for (const roomId in ROOMS) {
            let activeCount = 0;
            for (const p in ROOMS[roomId].players) {
                if (!ROOMS[roomId].players[p].disconnected) activeCount++;
            }
            if (activeCount > 0) {
                activeRooms.push({
                    id: roomId,
                    players: activeCount,
                    level: ROOMS[roomId].level
                });
            }
        }
        socket.emit('roomList', activeRooms);
    });

    socket.on('joinRoom', (data) => {
        if(!data || !data.roomId || !data.playerId) return;
        
        const roomId = data.roomId;
        const playerId = data.playerId;
        
        socket.join(roomId);
        socket.roomId = roomId;
        socket.playerId = playerId;

        if (!ROOMS[roomId]) {
            ROOMS[roomId] = {
                id: roomId,
                players: {},
                enemies: [],
                gems: [],
                baits: [],
                time: 0,
                lastBossTime: 0,
                level: 1,
                xp: 0,
                nextLevelXp: 100,
                paused: false,
                readyCount: 0,
                isGameOver: false,
                cleanupTimer: null,
                frozenUntil: 0 // Logika pro zamrznutí času
            };
        } else {
            if (ROOMS[roomId].cleanupTimer) {
                clearTimeout(ROOMS[roomId].cleanupTimer);
                ROOMS[roomId].cleanupTimer = null;
            }
        }

        if (!ROOMS[roomId].players[playerId]) {
            ROOMS[roomId].players[playerId] = {
                id: playerId, x: 0, y: 0, hp: 120, maxHp: 120, dead: false, hat: null, level: 1, disconnected: false, name: data.name || "Hráč"
            };
        } else {
            ROOMS[roomId].players[playerId].disconnected = false;
        }

        socket.emit('joined', { 
            roomId: roomId, 
            playerState: ROOMS[roomId].players[playerId] 
        });
    });

    socket.on('playerUpdate', (data) => {
        const r = socket.roomId;
        const p = socket.playerId;
        if (r && ROOMS[r] && ROOMS[r].players[p]) {
            Object.assign(ROOMS[r].players[p], data);
            
            if (data.dead && !ROOMS[r].isGameOver) {
                ROOMS[r].isGameOver = true;
                io.to(r).emit('teamGameOver');
                
                ROOMS[r].level = 1;
                ROOMS[r].xp = 0;
                ROOMS[r].nextLevelXp = 100;
                ROOMS[r].enemies = [];
                ROOMS[r].gems = [];
                ROOMS[r].baits = [];
                ROOMS[r].time = 0;
                ROOMS[r].paused = false;
                ROOMS[r].readyCount = 0;
                ROOMS[r].frozenUntil = 0;
                
                setTimeout(() => {
                    if (ROOMS[r]) ROOMS[r].isGameOver = false;
                }, 3000);
            }
        }
    });

    socket.on('shoot', (projData) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('enemyShoot', projData);
        }
    });

    socket.on('useAbility', (data) => {
        const r = socket.roomId;
        if (r && ROOMS[r]) {
            if (data.type === 2) {
                ROOMS[r].frozenUntil = Date.now() + 5000;
            } else if (data.type === 3 && data.enemyIds) {
                data.enemyIds.forEach(id => {
                    const e = ROOMS[r].enemies.find(en => en.id === id);
                    if (e && !e.isBoss) e.possessed = true;
                });
            }
        }
    });

    socket.on('enemyHit', (data) => {
        const r = socket.roomId;
        if (r && ROOMS[r]) {
            const enemy = ROOMS[r].enemies.find(e => e.id === data.id);
            if (enemy) {
                enemy.hp -= data.damage;
                if (enemy.hp <= 0) {
                    ROOMS[r].enemies = ROOMS[r].enemies.filter(e => e.id !== data.id);
                    ROOMS[r].gems.push({ id: Math.random().toString(36).substr(2, 9), x: enemy.x, y: enemy.y });
                }
            }
        }
    });

    socket.on('spawnBait', (data) => {
        const r = socket.roomId;
        if (r && ROOMS[r]) {
            ROOMS[r].baits.push({
                id: Math.random().toString(36).substr(2, 9),
                x: data.x, y: data.y, hp: data.hp, maxHp: data.hp
            });
        }
    });

    socket.on('baitHit', (data) => {
        const r = socket.roomId;
        if (r && ROOMS[r]) {
            const bait = ROOMS[r].baits.find(b => b.id === data.id);
            if (bait) {
                bait.hp -= data.damage;
                if (bait.hp <= 0) {
                    ROOMS[r].baits = ROOMS[r].baits.filter(b => b.id !== data.id);
                }
            }
        }
    });

    socket.on('gemPickup', (gemId) => {
        const r = socket.roomId;
        if (r && ROOMS[r]) {
            const room = ROOMS[r];
            room.gems = room.gems.filter(g => g.id !== gemId);
            io.to(r).emit('gemCollected', { gemId: gemId, playerId: socket.playerId });
            
            room.xp += 10;
            if (room.xp >= room.nextLevelXp) {
                room.level++;
                room.xp -= room.nextLevelXp;
                room.nextLevelXp = Math.floor(room.nextLevelXp * 1.25);
                room.paused = true;
                room.readyCount = 0;
                io.to(r).emit('teamLevelUp', { level: room.level });
            }
        }
    });
    
    socket.on('upgradePicked', () => {
        const r = socket.roomId;
        if (r && ROOMS[r]) {
            const room = ROOMS[r];
            room.readyCount++;
            const activePlayers = Object.values(room.players).filter(p => !p.dead && !p.disconnected).length;
            
            if (room.readyCount >= activePlayers) {
                room.paused = false;
                room.readyCount = 0;
                io.to(r).emit('resumeGame');
            }
        }
    });

    socket.on('disconnect', () => {
        const r = socket.roomId;
        const p = socket.playerId;
        if (r && ROOMS[r] && ROOMS[r].players[p]) {
            ROOMS[r].players[p].disconnected = true;
            
            let anyActive = false;
            let activePlayersCount = 0;
            for (const key in ROOMS[r].players) {
                if (!ROOMS[r].players[key].disconnected) {
                    anyActive = true;
                    if (!ROOMS[r].players[key].dead) activePlayersCount++;
                }
            }
            
            if (!anyActive) {
                ROOMS[r].cleanupTimer = setTimeout(() => {
                    delete ROOMS[r];
                }, 10 * 60 * 1000); 
            } else if (ROOMS[r].paused) {
                if (ROOMS[r].readyCount >= activePlayersCount && activePlayersCount > 0) {
                    ROOMS[r].paused = false;
                    ROOMS[r].readyCount = 0;
                    io.to(r).emit('resumeGame');
                }
            }
        }
    });

    // --- ADMIN KONZOLE PŘES SOCKET.IO ---
    socket.on('adminCommand', (data) => {
        const ADMIN_PASS = "moje_tajne_heslo"; // <-- ZMĚŇ SI HESLO!
        if (data.pass !== ADMIN_PASS) {
            return socket.emit('adminResponse', { msg: "CHYBA: Špatné heslo!", color: "red" });
        }

        const args = data.cmd.trim().split(' ');
        const cmd = args[0].toLowerCase();
        const target = args[1];

        if (cmd === 'give') {
            const amount = parseInt(args[2]);
            if (!target || isNaN(amount)) return socket.emit('adminResponse', { msg: "Použití: give <jméno> <počet>", color: "yellow" });
            db.get(`SELECT meta FROM accounts WHERE username = ?`, [target], (err, row) => {
                if (!row) return socket.emit('adminResponse', { msg: `Hráč ${target} nenalezen.`, color: "red" });
                let meta = JSON.parse(row.meta);
                meta.currency = (meta.currency || 0) + amount;
                db.run(`UPDATE accounts SET meta = ? WHERE username = ?`, [JSON.stringify(meta), target], () => {
                    socket.emit('adminResponse', { msg: `Úspěch: ${target} dostal ${amount} Doge. (Nyní má ${meta.currency})`, color: "lime" });
                });
            });
        } 
        else if (cmd === 'stats') {
            if (target) {
                db.get(`SELECT * FROM accounts WHERE username = ?`, [target], (err, row) => {
                    if (!row) return socket.emit('adminResponse', { msg: `Hráč ${target} nenalezen.`, color: "red" });
                    socket.emit('adminResponse', { msg: `Hráč: ${row.username} | Max Lvl: ${row.max_level}\nMeta: ${row.meta}`, color: "cyan" });
                });
            } else {
                db.all(`SELECT username, max_level FROM accounts ORDER BY max_level DESC`, [], (err, rows) => {
                    let text = `Zaregistrováno hráčů: ${rows.length}\n`;
                    rows.forEach(r => text += `- ${r.username} (Lvl ${r.max_level})\n`);
                    socket.emit('adminResponse', { msg: text, color: "cyan" });
                });
            }
        } 
        else if (cmd === 'delete') {
            if (!target) return socket.emit('adminResponse', { msg: "Použití: delete <jméno>", color: "yellow" });
            db.run(`DELETE FROM accounts WHERE username = ?`, [target], function(err) {
                if (this.changes > 0) socket.emit('adminResponse', { msg: `Účet ${target} byl smazán.`, color: "lime" });
                else socket.emit('adminResponse', { msg: `Hráč ${target} nenalezen.`, color: "red" });
                broadcastLeaderboard();
            });
        } 
        else if (cmd === 'rooms') {
            let count = Object.keys(ROOMS).length;
            let text = `Aktivní místnosti: ${count}\n`;
            for (let id in ROOMS) {
                text += `- ID: ${id} | Hráčů: ${Object.keys(ROOMS[id].players).length} | Lvl: ${ROOMS[id].level}\n`;
            }
            socket.emit('adminResponse', { msg: text, color: "cyan" });
        } 
        else {
            socket.emit('adminResponse', { msg: "Neznámý příkaz. Dostupné: give, stats, delete, rooms
