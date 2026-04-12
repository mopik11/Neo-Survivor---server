const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const ROOMS = {};

const CONFIG = {
    ENEMY_BASE_HEALTH: 20,
    ENEMY_BASE_SPEED: 2.2,
    SPAWN_INTERVAL: 800,
    BOSS_INTERVAL: 60
};

function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

io.on('connection', (socket) => {
    console.log('Hráč připojen:', socket.id);
    let currentRoom = null;

    socket.on('requestRooms', () => {
        const activeRooms = [];
        for (const roomId in ROOMS) {
            const playersCount = Object.keys(ROOMS[roomId].players).length;
            if (playersCount > 0) {
                activeRooms.push({
                    id: roomId,
                    players: playersCount,
                    level: ROOMS[roomId].level
                });
            }
        }
        socket.emit('roomList', activeRooms);
    });

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        currentRoom = roomId;

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
                isGameOver: false
            };
        }

        ROOMS[roomId].players[socket.id] = {
            id: socket.id, x: 0, y: 0, hp: 120, maxHp: 120, dead: false, hat: null, level: 1
        };

        socket.emit('joined', roomId);
    });

    socket.on('playerUpdate', (data) => {
        if (currentRoom && ROOMS[currentRoom] && ROOMS[currentRoom].players[socket.id]) {
            Object.assign(ROOMS[currentRoom].players[socket.id], data);
            
            if (data.dead && !ROOMS[currentRoom].isGameOver) {
                ROOMS[currentRoom].isGameOver = true;
                io.to(currentRoom).emit('teamGameOver');
                
                ROOMS[currentRoom].level = 1;
                ROOMS[currentRoom].xp = 0;
                ROOMS[currentRoom].nextLevelXp = 100;
                ROOMS[currentRoom].enemies = [];
                ROOMS[currentRoom].gems = [];
                ROOMS[currentRoom].baits = [];
                ROOMS[currentRoom].time = 0;
                ROOMS[currentRoom].paused = false;
                
                setTimeout(() => {
                    if (ROOMS[currentRoom]) ROOMS[currentRoom].isGameOver = false;
                }, 3000);
            }
        }
    });

    socket.on('shoot', (projData) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('enemyShoot', projData);
        }
    });

    socket.on('enemyHit', (data) => {
        if (currentRoom && ROOMS[currentRoom]) {
            const enemy = ROOMS[currentRoom].enemies.find(e => e.id === data.id);
            if (enemy) {
                enemy.hp -= data.damage;
                if (enemy.hp <= 0) {
                    ROOMS[currentRoom].enemies = ROOMS[currentRoom].enemies.filter(e => e.id !== data.id);
                    ROOMS[currentRoom].gems.push({ id: Math.random().toString(36).substr(2, 9), x: enemy.x, y: enemy.y });
                }
            }
        }
    });

    socket.on('spawnBait', (data) => {
        if (currentRoom && ROOMS[currentRoom]) {
            ROOMS[currentRoom].baits.push({
                id: Math.random().toString(36).substr(2, 9),
                x: data.x, y: data.y, hp: data.hp, maxHp: data.hp
            });
        }
    });

    socket.on('baitHit', (data) => {
        if (currentRoom && ROOMS[currentRoom]) {
            const bait = ROOMS[currentRoom].baits.find(b => b.id === data.id);
            if (bait) {
                bait.hp -= data.damage;
                if (bait.hp <= 0) {
                    ROOMS[currentRoom].baits = ROOMS[currentRoom].baits.filter(b => b.id !== data.id);
                }
            }
        }
    });

    socket.on('gemPickup', (gemId) => {
        if (currentRoom && ROOMS[currentRoom]) {
            const room = ROOMS[currentRoom];
            room.gems = room.gems.filter(g => g.id !== gemId);
            io.to(currentRoom).emit('gemCollected', { gemId: gemId, playerId: socket.id });
            
            room.xp += 10;
            if (room.xp >= room.nextLevelXp) {
                room.level++;
                room.xp -= room.nextLevelXp;
                room.nextLevelXp = Math.floor(room.nextLevelXp * 1.25);
                room.paused = true;
                room.readyCount = 0;
                io.to(currentRoom).emit('teamLevelUp', { level: room.level });
            }
        }
    });
    
    socket.on('upgradePicked', () => {
        if (currentRoom && ROOMS[currentRoom]) {
            const room = ROOMS[currentRoom];
            room.readyCount++;
            const activePlayers = Object.values(room.players).filter(p => !p.dead).length;
            
            if (room.readyCount >= activePlayers) {
                room.paused = false;
                io.to(currentRoom).emit('resumeGame');
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Hráč odpojen:', socket.id);
        if (currentRoom && ROOMS[currentRoom]) {
            delete ROOMS[currentRoom].players[socket.id];
            if (Object.keys(ROOMS[currentRoom].players).length === 0) {
                delete ROOMS[currentRoom];
            }
        }
    });
});

setInterval(() => {
    for (const roomId in ROOMS) {
        const room = ROOMS[roomId];
        if (room.paused || room.isGameOver) continue;
        
        room.time += 1 / 20;
        const playersArr = Object.values(room.players).filter(p => !p.dead);
        
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

            if (enemy.type === 2 && room.time - enemy.lastShot > 5) {
                io.to(roomId).emit('enemyShoot', {
                    x: enemy.x, y: enemy.y,
                    tx: target.x, ty: target.y,
                    dmg: 10, speed: CONFIG.PROJECTILE_SPEED * 1.2, size: 8
                });
                enemy.lastShot = room.time;
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
