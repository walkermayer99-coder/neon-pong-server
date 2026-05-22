// ============================================================================
// REAL-TIME AUTHORITATIVE MULTIPLAYER NEON PONG SERVER (Node.js + ws)
// ============================================================================

const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ port: process.env.PORT || 8080 }, () => {
    console.log(`Neon Pong Overdrive Server executing on port ${process.env.PORT || 8080}`);
});

// Active Room Storage
const rooms = new Map();

// --- GAME SIMULATION CONFIGURATION MATRIX ---
const Config = {
    virtualWidth: 900,
    virtualHeight: 550,
    paddleWidth: 14,
    paddleNormalHeight: 90,
    ballSize: 12,
    ballStartSpeed: 6.5,
    ballMaxSpeed: 19.0,
    winningScore: 7,
    tickRate: 1000 / 60 // 60 FPS update ticks (~16.66ms)
};

const PowerTypes = {
    BIG_PADDLE: { id: 1, label: 'BIG PADDLE', duration: 8000 },
    SHRINK_ENEMY: { id: 2, label: 'SHRINK ENEMY', duration: 8000 },
    SLOW_BALL: { id: 3, label: 'SLOW BALL', duration: 6000 },
    MULTI_BALL: { id: 4, label: 'MULTI-BALL', duration: 5000 }
};

// --- HELPER FUNCTION: ROOM CODE GENERATION ---
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// --- CORE GAME STATE LIFECYCLE ---
function createGameState() {
    return {
        status: 'waiting', // waiting, countdown, playing, gameover
        countdownValue: 3,
        countdownTimer: 0,
        score1: 0,
        score2: 0,
        rallyCount: 0,
        maxRally: 0,
        nextServeDirection: 1,
        
        // Paddle Allocations (Vertical Center Positions)
        p1Y: Config.virtualHeight / 2 - Config.paddleNormalHeight / 2,
        p2Y: Config.virtualHeight / 2 - Config.paddleNormalHeight / 2,
        p1Height: Config.paddleNormalHeight,
        p2Height: Config.paddleNormalHeight,

        balls: [],
        fieldPowerup: null,
        powerupSpawnTimer: 10000 + Math.random() * 5000,
        activeModifiers: [] // Active effects tracks
    };
}

// --- SERVE LAUNCH RUT ---
function serveBall(state, directionSign) {
    state.balls = [];
    let mainBall = {
        x: Config.virtualWidth / 2 - Config.ballSize / 2,
        y: Config.virtualHeight / 2 - Config.ballSize / 2,
        vx: 0,
        vy: 0,
        speed: Config.ballStartSpeed,
        isOriginal: true
    };
    const angle = (Math.random() - 0.5) * (Math.PI / 4);
    mainBall.vx = directionSign * mainBall.speed * Math.cos(angle);
    mainBall.vy = mainBall.speed * Math.sin(angle);
    state.balls.push(mainBall);
    state.rallyCount = 0;
}

// --- ADVANCED GAME LOOP PHYSICS STEP ---
function updateGamePhysics(room, dt) {
    const state = room.state;
    if (state.status !== 'playing') return;

    // 1. Process Modifiers Clocks
    let p1Big = false, p2Big = false, p1Shrink = false, p2Shrink = false, slowBall = false;
    
    for (let i = state.activeModifiers.length - 1; i >= 0; i--) {
        let mod = state.activeModifiers[i];
        mod.timeLeft -= dt;
        
        if (mod.typeId === PowerTypes.BIG_PADDLE.id) {
            if (mod.target === 1) p1Big = true; else p2Big = true;
        }
        if (mod.typeId === PowerTypes.SHRINK_ENEMY.id) {
            if (mod.target === 1) p1Shrink = true; else p2Shrink = true;
        }
        if (mod.typeId === PowerTypes.SLOW_BALL.id) slowBall = true;

        if (mod.timeLeft <= 0) state.activeModifiers.splice(i, 1);
    }

    // Morph paddle sizes dynamically
    let tP1H = p1Big ? Config.paddleNormalHeight * 1.5 : (p1Shrink ? Config.paddleNormalHeight * 0.5 : Config.paddleNormalHeight);
    let tP2H = p2Big ? Config.paddleNormalHeight * 1.5 : (p2Shrink ? Config.paddleNormalHeight * 0.5 : Config.paddleNormalHeight);
    state.p1Height += (tP1H - state.p1Height) * 0.1;
    state.p2Height += (tP2H - state.p2Height) * 0.1;

    // 2. Manage Field Powerup Spawns
    if (!state.fieldPowerup) {
        state.powerupSpawnTimer -= dt;
        if (state.powerupSpawnTimer <= 0) {
            const keys = Object.keys(PowerTypes);
            const chosen = PowerTypes[keys[Math.floor(Math.random() * keys.length)]];
            state.fieldPowerup = {
                x: Config.virtualWidth / 3 + Math.random() * (Config.virtualWidth / 3),
                y: 80 + Math.random() * (Config.virtualHeight - 160),
                typeId: chosen.id,
                label: chosen.label,
                size: 24
            };
            state.powerupSpawnTimer = 10000 + Math.random() * 5000;
            broadcastToRoom(room, { type: 'POWERUP_SPAWNED', x: state.fieldPowerup.x, y: state.fieldPowerup.y, color: getPowerColor(chosen.id), label: chosen.label });
        }
    }

    // 3. Vector Physics & Boundary Collisions
    let speedScalar = slowBall ? 0.7 : 1.0;

    for (let i = state.balls.length - 1; i >= 0; i--) {
        let b = state.balls[i];
        b.x += b.vx * speedScalar;
        b.y += b.vy * speedScalar;

        // Ceil / Floor Reflections
        if (b.y <= 0) {
            b.y = 0; b.vy *= -1;
            broadcastToRoom(room, { type: 'WALL_BOUNCE', x: b.x + Config.ballSize/2, y: b.y });
        } else if (b.y >= Config.virtualHeight - Config.ballSize) {
            b.y = Config.virtualHeight - Config.ballSize; b.vy *= -1;
            broadcastToRoom(room, { type: 'WALL_BOUNCE', x: b.x + Config.ballSize/2, y: b.y });
        }

        // Check Field Powerup Grab
        if (state.fieldPowerup) {
            let fp = state.fieldPowerup;
            if (b.x + Config.ballSize >= fp.x - fp.size/2 && b.x <= fp.x + fp.size/2 &&
                b.y + Config.ballSize >= fp.y - fp.size/2 && b.y <= fp.y + fp.size/2) {
                
                let lastHitter = (b.vx > 0) ? 1 : 2; // Last paddle hit determines power-up ownership
                executePowerupActivation(room, fp.typeId, lastHitter, b);
                state.fieldPowerup = null;
            }
        }

        // Paddle 1 Collision Check (Left Side)
        if (b.vx < 0 && b.x <= 35 && b.x >= 15) {
            if (b.y + Config.ballSize >= state.p1Y && b.y <= state.p1Y + state.p1Height) {
                calculatePaddleBounce(room, b, state.p1Y, state.p1Height, 1);
            }
        }

        // Paddle 2 Collision Check (Right Side)
        if (b.vx > 0 && b.x >= Config.virtualWidth - 35 - Config.ballSize && b.x <= Config.virtualWidth - 15) {
            if (b.y + Config.ballSize >= state.p2Y && b.y <= state.p2Y + state.p2Height) {
                calculatePaddleBounce(room, b, state.p2Y, state.p2Height, -1);
            }
        }

        // Scoring Triggers
        if (b.x < 0) {
            state.balls.splice(i, 1);
            if (b.isOriginal) {
                state.score2++;
                state.nextServeDirection = 1;
                handlePointScored(room, 2);
            }
        } else if (b.x > Config.virtualWidth) {
            state.balls.splice(i, 1);
            if (b.isOriginal) {
                state.score1++;
                state.nextServeDirection = -1;
                handlePointScored(room, 1);
            }
        }
    }

    // Safety Recovery Thread
    if (state.balls.length === 0 && state.status === 'playing') {
        serveBall(state, state.nextServeDirection);
    }
}

function calculatePaddleBounce(room, ball, paddleY, paddleHeight, directionSign) {
    const state = room.state;
    state.rallyCount++;
    if (state.rallyCount > state.maxRally) state.maxRally = state.rallyCount;

    const relativeIntersectY = (paddleY + (paddleHeight / 2)) - (ball.y + Config.ballSize / 2);
    const normalizedIntersectY = relativeIntersectY / (paddleHeight / 2);
    const bounceAngle = normalizedIntersectY * (Math.PI / 3);

    ball.speed = Math.min(Config.ballMaxSpeed, ball.speed + 0.65);
    ball.vx = directionSign * ball.speed * Math.cos(bounceAngle);
    ball.vy = ball.speed * -Math.sin(bounceAngle);

    broadcastToRoom(room, { 
        type: 'PADDLE_HIT', 
        x: ball.x + (directionSign > 0 ? 0 : Config.ballSize), 
        y: ball.y + Config.ballSize/2, 
        side: directionSign 
    });
}

function executePowerupActivation(room, typeId, collector, triggeringBall) {
    const state = room.state;
    let duration = 0;
    let target = collector; 
    let enemy = (collector === 1) ? 2 : 1;

    Object.values(PowerTypes).forEach(p => { if (p.id === typeId) duration = p.duration; });

    if (typeId === PowerTypes.MULTI_BALL.id) {
        for (let k = 0; k < 2; k++) {
            let angleShift = (k === 0 ? 0.35 : -0.35);
            state.balls.push({
                x: triggeringBall.x,
                y: triggeringBall.y,
                speed: triggeringBall.speed,
                vx: triggeringBall.vx * Math.cos(angleShift) - triggeringBall.vy * Math.sin(angleShift),
                vy: triggeringBall.vx * Math.sin(angleShift) + triggeringBall.vy * Math.cos(angleShift),
                isOriginal: false
            });
        }
    } else if (typeId === PowerTypes.BIG_PADDLE.id) {
        state.activeModifiers.push({ typeId, timeLeft: duration, target: target });
    } else if (typeId === PowerTypes.SHRINK_ENEMY.id) {
        state.activeModifiers.push({ typeId, timeLeft: duration, target: enemy }); // Target enemy side profile
    } else if (typeId === PowerTypes.SLOW_BALL.id) {
        state.activeModifiers.push({ typeId, timeLeft: duration });
    }

    broadcastToRoom(room, { type: 'POWERUP_COLLECTED', typeId, collector, color: getPowerColor(typeId) });
}

function handlePointScored(room, scoringPlayer) {
    const state = room.state;
    broadcastToRoom(room, { type: 'SCORE_EVENT', scoringPlayer, score1: state.score1, score2: state.score2 });

    if (state.score1 >= Config.winningScore || state.score2 >= Config.winningScore) {
        state.status = 'gameover';
        let winner = state.score1 >= Config.winningScore ? 1 : 2;
        broadcastToRoom(room, { type: 'GAME_OVER', winner, score1: state.score1, score2: state.score2, maxRally: state.maxRally });
    } else {
        startRoomCountdown(room);
    }
}

function startRoomCountdown(room) {
    const state = room.state;
    state.status = 'countdown';
    state.countdownValue = 3;
    state.balls = [];
    state.fieldPowerup = null;
    state.activeModifiers = [];
    
    const countTick = () => {
        if (!rooms.has(room.code) || state.status !== 'countdown') return;
        
        if (state.countdownValue > 0) {
            broadcastToRoom(room, { type: 'COUNTDOWN', val: state.countdownValue });
            state.countdownValue--;
            setTimeout(countTick, 750);
        } else {
            broadcastToRoom(room, { type: 'COUNTDOWN', val: 'GO!' });
            state.status = 'playing';
            serveBall(state, state.nextServeDirection);
        }
    };
    countTick();
}

function getPowerColor(id) {
    if (id === 1) return '#00ff66';
    if (id === 2) return '#ff0055';
    if (id === 3) return '#00f0ff';
    return '#ffea00';
}

// --- NETWORKING PACKET UTILITIES ---
function broadcastToRoom(room, payload) {
    const message = JSON.stringify(payload);
    if (room.p1 && room.p1.readyState === 1) room.p1.send(message);
    if (room.p2 && room.p2.readyState === 1) room.p2.send(message);
}

function runServerBroadcastLoop() {
    rooms.forEach((room, code) => {
        if (room.state.status === 'playing') {
            updateGamePhysics(room, Config.tickRate);
        }
        // Send state sync telemetry packets
        if (room.state.status === 'playing' || room.state.status === 'countdown') {
            const syncPayload = {
                type: 'SYNC',
                p1Y: room.state.p1Y,
                p2Y: room.state.p2Y,
                p1Height: room.state.p1Height,
                p2Height: room.state.p2Height,
                rally: room.state.rallyCount,
                balls: room.state.balls.map(b => ({ x: b.x, y: b.y, speed: b.speed, isOriginal: b.isOriginal })),
                modifiers: room.state.activeModifiers.map(m => ({ typeId: m.typeId, timeLeft: m.timeLeft, target: m.target })),
                powerup: room.state.fieldPowerup ? { x: room.state.fieldPowerup.x, y: room.state.fieldPowerup.y, id: room.state.fieldPowerup.typeId, label: room.state.fieldPowerup.label } : null
            };
            broadcastToRoom(room, syncPayload);
        }
    });
}
setInterval(runServerBroadcastLoop, Config.tickRate);

// --- INBOUND CONNECTION DRIVER ENGINE ---
wss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.playerSlot = null;

    ws.on('message', (msg) => {
        try {
            const packet = JSON.parse(msg);
            
            // Handler: Room Creation Sequence
            if (packet.type === 'CREATE') {
                let code = generateRoomCode();
                while (rooms.has(code)) { code = generateRoomCode(); }
                
                let room = {
                    code: code,
                    p1: ws,
                    p2: null,
                    state: createGameState()
                };
                
                rooms.set(code, room);
                ws.roomCode = code;
                ws.playerSlot = 1;
                
                ws.send(JSON.stringify({ type: 'ROOM_CREATED', code: code, slot: 1 }));
                return;
            }

            // Handler: Room Entry Sequence
            if (packet.type === 'JOIN') {
                let code = packet.code.toUpperCase().trim();
                if (!rooms.has(code)) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Room code matrix not found.' }));
                    return;
                }
                let room = rooms.get(code);
                if (room.p2 !== null) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Target Simulation environment is full.' }));
                    return;
                }

                room.p2 = ws;
                ws.roomCode = code;
                ws.playerSlot = 2;

                ws.send(JSON.stringify({ type: 'ROOM_JOINED', code: code, slot: 2 }));
                broadcastToRoom(room, { type: 'MATCH_READY' });
                
                // Initialize match count operations
                setTimeout(() => startRoomCountdown(room), 1000);
                return;
            }

            // Handler: Inbound Real-time Controller Interceptions
            if (packet.type === 'INPUT') {
                if (!ws.roomCode || !rooms.has(ws.roomCode)) return;
                let room = rooms.get(ws.roomCode);
                if (ws.playerSlot === 1) {
                    room.state.p1Y = packet.y;
                } else if (ws.playerSlot === 2) {
                    room.state.p2Y = packet.y;
                }
            }

        } catch (e) {}
    });

    ws.on('close', () => {
        if (ws.roomCode && rooms.has(ws.roomCode)) {
            let room = rooms.get(ws.roomCode);
            
            if (ws.playerSlot === 1) {
                room.p1 = null;
                if (room.p2) room.p2.send(JSON.stringify({ type: 'OPPONENT_DISCONNECTED' }));
            } else {
                room.p2 = null;
                if (room.p1) room.p1.send(JSON.stringify({ type: 'OPPONENT_DISCONNECTED' }));
            }

            // Clean room matrix if both endpoints have decoupled
            if (!room.p1 && !room.p2) {
                rooms.delete(ws.roomCode);
                console.log(`Room Vector ${ws.roomCode} deleted from memory completely.`);
            }
        }
    });
});
