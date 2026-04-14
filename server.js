const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose(); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// --- INICIALIZACE DATABÁZE ---
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
// ------------------------------

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

    // --- SYSTÉM ÚČTŮ (V DATABÁZI) ---
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
                selectedShip: 1
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
                socket.emit('loginResponse', { success: true, meta: JSON.parse(row.meta) });
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
    // -------------------

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
                cleanupTimer: null
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
});

setInterval(() => {
    for (const roomId in ROOMS) {
        const room = ROOMS[roomId];
        if (room.paused || room.isGameOver) continue;
        
        room.time += 1 / 20;
        
        const playersArr = Object.values(room.players).filter(p => !p.dead && !p.disconnected);
        
        const currentInterval = Math.max(100, CONFIG.SPAWN_INTERVAL / (1 + room.time / 60));
        const spawnChance = 1 / (currentInterval / 50);

        if (playersArr.length > 0 && Math.random() < spawnChance) {
            const pivot = playersArr[Math.floor(Math.random() * playersArr.length)];
            const a = Math.random() * Math.PI * 2;
            const radius = 700;
            const x = pivot.x + Math.cos(a) * radius;
            const y = pivot.y + Math.sin(a) * radius;
            const mod = Math.floor(room.time / 60) + 1;
            
            let isBoss = false;
            let hp = CONFIG.ENEMY_BASE_HEALTH * mod;
            let type = 1;
            
            if (room.level >= 3 && Math.random() < 0.1) {
                type = 2;
                hp *= 0.5;
            }

            if (room.level >= 20 && (room.time - room.lastBossTime > CONFIG.BOSS_INTERVAL)) {
                isBoss = true;
                hp = CONFIG.ENEMY_BASE_HEALTH * 30 * mod;
                type = 1;
                room.lastBossTime = room.time;
            }

            room.enemies.push({
                id: Math.random().toString(36).substr(2, 9),
                x: x, y: y, hp: hp, maxHp: hp, isBoss: isBoss, type: type,
                lastShot: room.time,
                mod: mod 
            });
        }

        const targets = [...playersArr, ...room.baits];

        room.enemies.forEach(enemy => {
            if (targets.length === 0) return; 
            const target = targets.sort((a, b) => dist(enemy.x, enemy.y, a.x, a.y) - dist(enemy.x, enemy.y, b.x, b.y))[0];
            const angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
            
            let speedMult = 1;
            if (enemy.isBoss) speedMult = 0.8;
            if (enemy.type === 2) speedMult = 0.5;
            
            const enemyMod = enemy.mod || 1;
            const speed = (CONFIG.ENEMY_BASE_SPEED + (enemyMod * 0.15)) * speedMult;
            
            enemy.x += Math.cos(angle) * speed;
            enemy.y += Math.sin(angle) * speed;

            // MULTIPLAYER DYNAMICKÁ RYCHLOST A PŘESNOST PRO NEPŘÍTELE 2
            if (enemy.type === 2) {
                let currentLvl = room.level || 1;
                let shootInterval = Math.max(1.5, 5.0 - (currentLevel * 0.15)); 
                
                if (room.time - enemy.lastShot > shootInterval) {
                    let inaccuracy = Math.max(0, 0.6 - (currentLevel * 0.04)); 
                    let baseAngle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
                    let finalAngle = baseAngle + (Math.random() - 0.5) * inaccuracy;
                    
                    let tx = enemy.x + Math.cos(finalAngle) * 100;
                    let ty = enemy.y + Math.sin(finalAngle) * 100;

                    io.to(roomId).emit('enemyShoot', {
                        x: enemy.x, y: enemy.y,
                        tx: tx, ty: ty,
                        dmg: 10, speed: CONFIG.PROJECTILE_SPEED * 1.2, size: 8,
                        type: 'default' 
                    });
                    enemy.lastShot = room.time;
                }
            }
        });

        io.to(roomId).emit('stateUpdate', {
            players: room.players,
            enemies: room.enemies,
            gems: room.gems,
            baits: room.baits,
            time: room.time,
            roomInfo: {
                level: room.level,
                xp: room.xp,
                nextLevelXp: room.nextLevelXp
            }
        });
    }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server bezi na portu ${PORT}`));
