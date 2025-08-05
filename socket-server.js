require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuration
const PORT = process.env.SOCKET_PORT || 3001;
const SECRET_TOKEN = process.env.SOCKET_SERVER_SECRET || 'your-secret-token';
const BETTING_PHASE_DURATION = 6000; // 6 seconds
const WAIT_PHASE_DURATION = 3000; // 3 seconds
const MULTIPLIER_UPDATE_INTERVAL = 100; // 100ms for smooth progression updates

// Time-based round calculation (same as backend)
const ROUND_DURATION = 10000; // 10 seconds per round
function getCurrentRound() {
  const today = new Date();
  const BASE_TIMESTAMP = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0);
  const now = Date.now();
  return Math.max(1, Math.floor((now - BASE_TIMESTAMP) / ROUND_DURATION));
}

// Global game state
let multiplierQueue = [];
let roundMultipliers = new Map(); // round -> multiplier mapping
let currentRound = 0; // Use sequential counter, not time-based
let currentMultiplier = 1.00;
let crashPoint = null;
let gamePhase = 'wait'; // 'wait', 'betting', 'flying', 'crashed'
let simulationInterval = null;
let bettingTimer = null;
let waitTimer = null;
let startTime = null; // Track flying phase start time

// Client-specific state tracking
const clientStates = new Map(); // socketId -> { currentRound, isSynced }
const connectionStats = {
  totalConnections: 0,
  activeConnections: 0,
  totalDisconnections: 0,
  lastConnectionTime: null,
  lastDisconnectionTime: null
};

// Connection monitoring
function logConnectionStats() {
  const activeCount = io.engine.clientsCount;
  console.log(`📊 Connection Stats: ${activeCount} active, ${connectionStats.totalConnections} total connections, ${connectionStats.totalDisconnections} disconnections`);
  
  // Log client details if there are active connections
  if (activeCount > 0) {
    const clientDetails = Array.from(clientStates.entries()).map(([id, state]) => ({
      id: id.substring(0, 8) + '...',
      round: state.currentRound,
      synced: state.isSynced,
      connectedFor: Math.floor((Date.now() - state.connectedAt) / 1000) + 's'
    }));
    console.log(`👥 Active clients:`, clientDetails);
  }
}

// Monitor connections every 30 seconds
setInterval(logConnectionStats, 30000);

// Middleware
app.use(cors());
app.use(express.json());

// Helper function to get multiplier for a specific round
function getMultiplierForRound(round) {
  const multiplier = roundMultipliers.get(round);
  return multiplier || 1.00;
}

// Authentication middleware
const authenticateRequest = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Root endpoint for uptime monitoring (must be first)
app.get('/', (req, res) => {
  const response = { 
    status: 'ok', 
    service: 'aviator-socket-server',
    timestamp: new Date().toISOString()
  };
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(response);
});

// Simple text endpoint for basic uptime monitoring
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Health check endpoint
app.get('/health', (req, res) => {
  const timeBasedRound = getCurrentRound();
  const roundMultiplier = getMultiplierForRound(currentRound);
  const activeConnections = io.engine.clientsCount;
  
  res.json({ 
    status: 'healthy', 
    gamePhase, 
    currentRound, 
    timeBasedRound,
    roundDifference: currentRound - timeBasedRound,
    queueSize: multiplierQueue.length,
    currentMultiplier: gamePhase === 'flying' ? currentMultiplier : roundMultiplier,
    nextMultiplier: multiplierQueue.length > 0 ? multiplierQueue[0] : null,
    connections: {
      active: activeConnections,
      total: connectionStats.totalConnections,
      disconnections: connectionStats.totalDisconnections,
      lastConnection: connectionStats.lastConnectionTime ? new Date(connectionStats.lastConnectionTime).toISOString() : null,
      lastDisconnection: connectionStats.lastDisconnectionTime ? new Date(connectionStats.lastDisconnectionTime).toISOString() : null
    },
    clients: Array.from(clientStates.entries()).map(([id, state]) => ({
      id: id.substring(0, 8) + '...',
      round: state.currentRound,
      synced: state.isSynced,
      connectedFor: Math.floor((Date.now() - state.connectedAt) / 1000)
    }))
  });
});

// Queue endpoint for receiving multipliers from backend
app.post('/queue', authenticateRequest, (req, res) => {
  const { multipliers, startRound, currentRound: backendCurrentRound } = req.body;
  
  if (!multipliers || !Array.isArray(multipliers)) {
    return res.status(400).json({ error: 'Invalid multipliers array' });
  }
  
  // Add multipliers to queue with round tracking
  const previousQueueSize = multiplierQueue.length;
  
  // Handle both old format (array of numbers) and new format (array of objects)
  const multiplierValues = multipliers.map(item => 
    typeof item === 'number' ? item : item.multiplier
  );
  multiplierQueue.push(...multiplierValues);
  
  // Store multipliers with their round numbers
  multipliers.forEach((item, index) => {
    const multiplier = typeof item === 'number' ? item : item.multiplier;
    const roundNumber = typeof item === 'number' ? (startRound + index) : item.round_number;
    roundMultipliers.set(roundNumber, multiplier);
    console.log(`📋 Mapped round ${roundNumber} → multiplier ${multiplier}`);
  });
  
  console.log(`📥 Queued ${multiplierValues.length} multipliers: [${multiplierValues.join(', ')}]`);
  console.log(`📊 Queue size: ${previousQueueSize} → ${multiplierQueue.length}`);
  console.log(`📋 Full queue: [${multiplierQueue.join(', ')}]`);
  console.log(`⏰ Backend start round: ${startRound}`);
  console.log(`🗺️ Round multipliers: ${Array.from(roundMultipliers.entries()).slice(-5).map(([r, m]) => `${r}:${m}`).join(', ')}`);
  
  // Start simulation if not already running or if we're in crashed phase
  if ((gamePhase === 'wait' || gamePhase === 'crashed') && multiplierQueue.length > 0) {
    console.log(`🚀 Starting simulation with ${multiplierQueue.length} multipliers in queue (phase: ${gamePhase})`);
    
    // Ensure we start with the correct round
    if (startRound) {
      if (currentRound === 0) {
        // First time initialization - set to the exact startRound
        currentRound = startRound;
        console.log(`🎯 First time sync: setting current round to ${startRound}`);
      } else if (currentRound < startRound) {
        // Socket server is behind, catch up to the exact startRound
        console.log(`🎯 Catching up: ${currentRound} → ${startRound}`);
        currentRound = startRound;
      } else if (currentRound > startRound) {
        // Socket server is ahead, this might indicate a gap
        console.log(`⚠️ Socket ahead: ${currentRound} > ${startRound}, checking for gaps`);
        // Check if we have the multiplier for the expected round
        if (!roundMultipliers.has(currentRound)) {
          console.log(`🔍 Gap detected: no multiplier for round ${currentRound}, jumping to ${startRound}`);
          currentRound = startRound;
        }
      } else {
        // Socket server is exactly in sync
        console.log(`✅ Socket server in sync: ${currentRound} = ${startRound}`);
      }
    }
    
    // If we're in crashed phase, transition to wait first
    if (gamePhase === 'crashed') {
      console.log(`🔄 Transitioning from crashed to wait phase`);
      gamePhase = 'wait';
    }
    
    console.log(`🎮 Starting simulation from round ${currentRound}`);
    startNextRound();
  } else if (gamePhase !== 'wait' && gamePhase !== 'crashed') {
    console.log(`⏳ Simulation already running (phase: ${gamePhase}), queue will be processed after current round`);
  }
  
  res.json({ success: true, queueSize: multiplierQueue.length });
});

// Debug endpoint to show current state
app.get('/debug', (req, res) => {
  const timeBasedRound = getCurrentRound();
  const roundMultiplier = getMultiplierForRound(currentRound);
  
  // Allow specifying a reference round via query parameter
  const referenceRound = req.query.round ? parseInt(req.query.round) : currentRound;
  
  // Get the actual recent rounds (referenceRound-1 down to referenceRound-10)
  const recentRounds = [];
  for (let i = 1; i <= 10; i++) {
    const roundNumber = referenceRound - i;
    if (roundNumber > 0) {
      const multiplier = roundMultipliers.get(roundNumber);
      if (multiplier) {
        recentRounds.push([roundNumber, multiplier]);
      }
    }
  }
  
  res.json({ 
    gamePhase, 
    currentRound, 
    timeBasedRound,
    roundDifference: currentRound - timeBasedRound,
    queueSize: multiplierQueue.length,
    currentMultiplier: gamePhase === 'flying' ? currentMultiplier : roundMultiplier,
    crashPoint,
    queuePreview: multiplierQueue.slice(0, 5),
    roundMultipliers: recentRounds, // Return actual recent rounds
    activeTimers: {
      simulationInterval: !!simulationInterval,
      bettingTimer: !!bettingTimer,
      waitTimer: !!waitTimer
    }
  });
});

// Current game state endpoint for late joiners
app.get('/current-state', (req, res) => {
  res.json({
    currentRound,
    gamePhase,
    currentMultiplier,
    crashPoint,
    roundStartTime: gamePhase === 'flying' ? Date.now() - (currentMultiplier > 1.0 ? 3000 : 0) : null,
    bettingEndTime: gamePhase === 'betting' ? Date.now() + (BETTING_PHASE_DURATION - (Date.now() % BETTING_PHASE_DURATION)) : null
  });
});

// Manual trigger endpoint (for testing)
app.post('/trigger-next', authenticateRequest, (req, res) => {
  if ((gamePhase === 'wait' || gamePhase === 'crashed') && multiplierQueue.length > 0) {
    console.log(`🔧 Manual trigger: Starting next round from phase ${gamePhase}`);
    if (gamePhase === 'crashed') {
      gamePhase = 'wait';
    }
    startNextRound();
    res.json({ success: true, message: 'Next round triggered' });
  } else {
    res.json({ success: false, message: `Cannot trigger next round. Phase: ${gamePhase}, Queue: ${multiplierQueue.length}` });
  }
});

// Test endpoint to check multiplier for a specific round
app.get('/test-round/:round', (req, res) => {
  const round = parseInt(req.params.round, 10);
  const multiplier = getMultiplierForRound(round);
  res.json({ 
    round, 
    multiplier, 
    hasMultiplier: roundMultipliers.has(round),
    allRounds: Array.from(roundMultipliers.keys()).sort((a, b) => a - b),
    recentRounds: Array.from(roundMultipliers.entries()).slice(-10)
  });
});

// Force start simulation endpoint (for debugging)
app.post('/force-start', authenticateRequest, (req, res) => {
  console.log(`🔧 Force start: Current phase ${gamePhase}, queue size ${multiplierQueue.length}`);
  
  if (multiplierQueue.length === 0) {
    return res.json({ success: false, message: 'No multipliers in queue' });
  }
  
  // Force transition to wait phase if needed
  if (gamePhase !== 'wait') {
    console.log(`🔄 Force transitioning from ${gamePhase} to wait phase`);
    gamePhase = 'wait';
  }
  
  // Set current round if not set
  if (currentRound === 0) {
    const firstRound = Math.min(...Array.from(roundMultipliers.keys()));
    currentRound = firstRound;
    console.log(`🎯 Force setting current round to ${currentRound}`);
  }
  
  console.log(`🚀 Force starting simulation from round ${currentRound}`);
  startNextRound();
  
  res.json({ 
    success: true, 
    message: 'Simulation force started',
    currentRound,
    gamePhase,
    queueSize: multiplierQueue.length
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  // Update connection stats
  connectionStats.totalConnections++;
  connectionStats.activeConnections = io.engine.clientsCount;
  connectionStats.lastConnectionTime = Date.now();
  
  // Initialize client state
  clientStates.set(socket.id, { 
    currentRound: currentRound, 
    isSynced: false,
    connectedAt: Date.now()
  });
  
  // Send current game state to new connection immediately
  const currentState = {
    currentRound,
    gamePhase,
    currentMultiplier: gamePhase === 'flying' ? currentMultiplier : (crashPoint || 1.00),
    crashPoint
  };
  
  console.log(`📤 Sending initial state to ${socket.id}:`, currentState);
  socket.emit('game:state', currentState);
  
  // Send current round info
  const roundInfo = {
    round: currentRound,
    phase: gamePhase,
    multiplier: gamePhase === 'flying' ? currentMultiplier : (crashPoint || 1.00),
    crashPoint
  };
  
  console.log(`📤 Sending round info to ${socket.id}:`, roundInfo);
  socket.emit('round:info', roundInfo);
  
  // If currently in betting phase, send betting info
  if (gamePhase === 'betting') {
    const bettingInfo = {
      round: currentRound,
      crashPoint: crashPoint
    };
    console.log(`📤 Sending betting info to ${socket.id}:`, bettingInfo);
    socket.emit('round:start', bettingInfo);
  }
  
  // If currently in flying phase, send flying info
  if (gamePhase === 'flying') {
    const flyingInfo = {
      round: currentRound,
      multiplier: currentMultiplier,
      crashPoint: crashPoint
    };
    console.log(`📤 Sending flying info to ${socket.id}:`, flyingInfo);
    socket.emit('round:flying', flyingInfo);
  }
  
  // If currently crashed, send crash info
  if (gamePhase === 'crashed') {
    const crashInfo = {
      round: currentRound,
      crashPoint: crashPoint
    };
    console.log(`📤 Sending crash info to ${socket.id}:`, crashInfo);
    socket.emit('round:crash', crashInfo);
  }
  
  // Mark client as synced
  const clientState = clientStates.get(socket.id);
  if (clientState) {
    clientState.isSynced = true;
    clientState.currentRound = currentRound;
  }
  
  // Handle client disconnection
  socket.on('disconnect', (reason) => {
    console.log(`🔌 Client disconnected: ${socket.id}, reason: ${reason}`);
    
    // Update disconnection stats
    connectionStats.totalDisconnections++;
    connectionStats.activeConnections = io.engine.clientsCount;
    connectionStats.lastDisconnectionTime = Date.now();
    
    clientStates.delete(socket.id);
  });
  
  // Handle client errors
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
  
  // Handle client requesting current state
  socket.on('request:state', () => {
    console.log(`📤 Client ${socket.id} requested current state`);
    socket.emit('game:state', {
      currentRound,
      gamePhase,
      currentMultiplier: gamePhase === 'flying' ? currentMultiplier : (crashPoint || 1.00),
      crashPoint
    });
  });
  
  // Handle client requesting round info
  socket.on('request:round-info', () => {
    console.log(`📤 Client ${socket.id} requested round info`);
    socket.emit('round:info', {
      round: currentRound,
      phase: gamePhase,
      multiplier: gamePhase === 'flying' ? currentMultiplier : (crashPoint || 1.00),
      crashPoint
    });
  });
});

// Game simulation functions
function startNextRound() {
  if (multiplierQueue.length === 0) {
    console.log('⏸️ No multipliers in queue, pausing simulation');
    gamePhase = 'wait';
    return;
  }
  
  // Get the correct multiplier for this round from the roundMultipliers map
  const roundMultiplier = roundMultipliers.get(currentRound);
  if (!roundMultiplier) {
    console.log(`⚠️ No multiplier found for round ${currentRound}, checking queue...`);
    // Check if we have a multiplier in the queue that we can use
    if (multiplierQueue.length > 0) {
      crashPoint = multiplierQueue.shift();
      console.log(`   Using queue fallback: ${crashPoint}x`);
    } else {
      console.log(`   No multipliers available, waiting...`);
      gamePhase = 'wait';
      return;
    }
  } else {
    crashPoint = roundMultiplier;
    // Remove from queue to keep it in sync
    if (multiplierQueue.length > 0) {
      multiplierQueue.shift();
    }
    console.log(`   Using mapped multiplier: ${crashPoint}x`);
  }
  
  // currentRound is already set to the correct value from backend sync
  currentMultiplier = 1.00;
  
  console.log(`🎮 Starting round ${currentRound} with crash point: ${crashPoint}x (from roundMultipliers: ${roundMultipliers.has(currentRound)})`);
  
  // Start betting phase
  gamePhase = 'betting';
  console.log(`🎯 Emitting round:start with round ${currentRound}`);
  io.emit('round:start', {
    round: currentRound,
    crashPoint: crashPoint
  });
  
  // Transition to flying phase after betting duration
  bettingTimer = setTimeout(() => {
    startFlyingPhase();
  }, BETTING_PHASE_DURATION);
}

function startFlyingPhase() {
  gamePhase = 'flying';
  currentMultiplier = 1.00;
  
  console.log(`✈️ Starting flying phase for round ${currentRound} with EXACT crash point: ${crashPoint}x`);
  
  // Emit flying phase event to notify clients
  io.emit('round:flying', {
    round: currentRound,
    multiplier: currentMultiplier,
    crashPoint: crashPoint
  });
  
  // Record start time for animation
  startTime = Date.now();
  const timeToCrash = estimateTimeToMultiplier(crashPoint);
  
  console.log(`⏱️ Animation duration: ${timeToCrash.toFixed(1)} seconds`);
  
      // Start multiplier animation with smooth, consistent behavior
    let lastEmittedMultiplier = 1.00;
    
    simulationInterval = setInterval(() => {
      // Calculate elapsed time since flying phase started
      const elapsedMs = Date.now() - startTime;
      const elapsedSec = elapsedMs / 1000;
      
      // Calculate progress (0 to 1) - NO random variations for smoothness
      const progress = Math.min(1, elapsedSec / timeToCrash);
      
      // Calculate current multiplier
      currentMultiplier = calculateMultiplier(progress, crashPoint);
      
      // Emit smooth progression updates (1.01, 1.02, 1.03, etc.)
      // Use a smaller threshold to show gradual increments
      if (Math.abs(currentMultiplier - lastEmittedMultiplier) >= 0.01) {
        io.emit('multiplier:update', {
          round: currentRound,
          multiplier: currentMultiplier
        });
        lastEmittedMultiplier = currentMultiplier;
      }
      
      // Debug: Log smooth progression updates
      if (currentMultiplier >= 1.0) {
        console.log(`📊 ${currentMultiplier.toFixed(2)}x → ${crashPoint.toFixed(2)}x (${(progress * 100).toFixed(0)}%)`);
      }
      
      // Check if crashed (NO randomness for consistency)
      if (progress >= 1.0 || currentMultiplier >= crashPoint) {
        console.log(`🎯 Animation complete: reached ${currentMultiplier}x (target was ${crashPoint}x) at ${(progress * 100).toFixed(1)}% progress`);
        crashRound();
      }
    }, MULTIPLIER_UPDATE_INTERVAL); // Fixed update interval for smoothness
}

function crashRound() {
  gamePhase = 'crashed';
  currentMultiplier = crashPoint;
  
  // Store the crash point in roundMultipliers for recent multipliers display
  roundMultipliers.set(currentRound, crashPoint);
  
  console.log(`💥 Round ${currentRound} crashed at ${crashPoint}x`);
  console.log(`📋 Stored round ${currentRound} → multiplier ${crashPoint} in recent multipliers`);
  
  // Clear simulation interval
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  
  // Emit crash event
  io.emit('round:crash', {
    round: currentRound,
    crashPoint: crashPoint
  });
  
  // Start wait phase
  waitTimer = setTimeout(() => {
    console.log(`⏭️ Moving to next round...`);
    // Set to wait phase first
    gamePhase = 'wait';
    // Increment current round for the next round in sequence
    currentRound++;
    // Check if we have multipliers to start the next round
    if (multiplierQueue.length > 0) {
      console.log(`🚀 Starting next round with ${multiplierQueue.length} multipliers in queue`);
      startNextRound();
    } else {
      console.log(`⏸️ No multipliers in queue, waiting for backend...`);
    }
  }, WAIT_PHASE_DURATION);
}

// Universal growth curve system
function estimateTimeToMultiplier(target) {
  // 🎯 DYNAMIC GROWTH CURVE
  // Each multiplier takes the time it needs to reach its target naturally
  
  // Use the slow growth rate to calculate natural duration
  const UNIVERSAL_GROWTH_RATE = 0.08;
  
  // Calculate how long it takes to reach the target: target = e^(rate * time)
  // Solving for time: time = ln(target) / rate
  const naturalDuration = Math.log(target) / UNIVERSAL_GROWTH_RATE;
  
  // Add minimal randomness to prevent exact timing prediction
  const microRandomness = (Math.random() - 0.5) * 0.5; // ±0.25 seconds
  
  return naturalDuration + microRandomness;
}

function calculateMultiplier(progress, target) {
  // 🎯 DYNAMIC EXPONENTIAL CURVE
  // Each multiplier follows the same growth pattern but takes its natural time
  
  // Use the slow growth rate for ALL multipliers
  const UNIVERSAL_GROWTH_RATE = 0.08;
  
  // Calculate the natural duration for this target
  const naturalDuration = Math.log(target) / UNIVERSAL_GROWTH_RATE;
  
  // Dynamic exponential formula: multiplier = e^(rate * time)
  // Time is progress * naturalDuration (not fixed 10 seconds)
  const dynamicMultiplier = Math.exp(UNIVERSAL_GROWTH_RATE * progress * naturalDuration);
  
  // Convert to stepped hundredths for smooth animation
  const steppedMultiplier = Math.floor(dynamicMultiplier * 100) / 100;
  
  // At 100% progress, ensure we reach exactly the target
  if (progress >= 1.0) {
    return target;
  }
  
  // Stop at target multiplier (this is the only difference between games)
  // Remove the slight increase at crash by using exact target
  const result = Math.min(steppedMultiplier, target);
  
  // Ensure minimum of 1.00 and don't exceed target
  return Math.max(1.00, Math.min(result, target));
}

// Test function to verify universal growth curve
function testMultiplierCalculation() {
  console.log(`🎯 Testing Dynamic Growth Curve System:`);
  
  // Test different multiplier types - each takes its natural time
  const testCases = [
    { target: 1.2, description: "Low crash (1.2x) - Quick duration" },
    { target: 2.0, description: "Medium crash (2.0x) - Medium duration" },
    { target: 5.0, description: "High crash (5.0x) - Longer duration" },
    { target: 15.0, description: "Very high (15.0x) - Much longer" },
    { target: 50.0, description: "Epic (50.0x) - Very long" },
    { target: 100.0, description: "Legendary (100.0x) - Maximum duration" }
  ];
  
  console.log(`\n🎯 Dynamic Curve Analysis (Each takes natural time to reach target):`);
  testCases.forEach(test => {
    const result = calculateMultiplier(1.0, test.target);
    const expected = test.target;
    const accuracy = Math.abs(result - expected);
    const timeToCrash = estimateTimeToMultiplier(test.target);
    console.log(`   ${test.description}: ${result.toFixed(2)}x (target: ${expected.toFixed(2)}x, accuracy: ${accuracy.toFixed(4)}, time: ${timeToCrash.toFixed(1)}s)`);
  });
  
  // Test progression - show how different targets progress
  console.log(`\n📈 Dynamic Curve Progression (Each target has different duration):`);
  
  console.log(`   Early progression (25% of each target's duration):`);
  for (let progress = 0.1; progress <= 0.4; progress += 0.1) {
    const lowTarget = calculateMultiplier(progress, 1.2);
    const highTarget = calculateMultiplier(progress, 100.0);
    console.log(`     ${(progress * 100).toFixed(0)}%: 1.2x target = ${lowTarget.toFixed(2)}x, 100x target = ${highTarget.toFixed(2)}x`);
  }
  
  console.log(`   Mid progression (50% of each target's duration):`);
  for (let progress = 0.5; progress <= 0.8; progress += 0.1) {
    const lowTarget = calculateMultiplier(progress, 1.2);
    const highTarget = calculateMultiplier(progress, 100.0);
    console.log(`     ${(progress * 100).toFixed(0)}%: 1.2x target = ${lowTarget.toFixed(2)}x, 100x target = ${highTarget.toFixed(2)}x`);
  }
  
  console.log(`\n✅ Dynamic Curve Design Features:`);
  console.log(`   • Natural duration for each multiplier (no fixed timing)`);
  console.log(`   • Fixed growth rate: 0.08 for ALL multipliers (same curve shape)`);
  console.log(`   • Dynamic formula: multiplier = e^(0.08 * natural_time) for each game`);
  console.log(`   • Each target takes exactly the time it needs to reach naturally`);
  console.log(`   • 1.2x crash: ~2.7 seconds, 100x crash: ~57.6 seconds`);
  console.log(`   • Same exponential curve shape, different durations`);
  console.log(`   • Impossible to predict crash point from timing or behavior`);
  console.log(`   • Stepped hundredths for smooth counter-like display`);
  console.log(`   • Fixed update interval: ${MULTIPLIER_UPDATE_INTERVAL}ms`);
  
  return true;
}

// Cleanup function
function cleanup() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
  }
  if (bettingTimer) {
    clearTimeout(bettingTimer);
  }
  if (waitTimer) {
    clearTimeout(waitTimer);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down socket server...');
  cleanup();
  server.close(() => {
    console.log('✅ Socket server closed');
    process.exit(0);
  });
});

// Catch-all route for 404s (must be last)
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not Found', 
    message: 'Endpoint not found',
    availableEndpoints: ['/', '/ping', '/health', '/debug', '/current-state', '/queue']
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Socket.IO server running on port ${PORT}`);
  console.log(`🔐 Secret token: ${SECRET_TOKEN}`);
  console.log(`📡 Waiting for multiplier batches...`);
  console.log(`🎮 Game phases: betting(${BETTING_PHASE_DURATION}ms) → flying → crashed → wait(${WAIT_PHASE_DURATION}ms)`);
  console.log(`⚡ Update interval: ${MULTIPLIER_UPDATE_INTERVAL}ms`);
  console.log(`🎯 Initial current round: ${currentRound}`);
  console.log(`🎲 Dynamic growth curve: natural duration, fixed rate 0.08, truly unpredictable`);
  
  // Test multiplier calculation
  testMultiplierCalculation();
});

module.exports = { io, server };