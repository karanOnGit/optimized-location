#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# EC2 Deployment Script — Pickup & Drop Location Manager
# Run this on a fresh Ubuntu EC2 instance
# ═══════════════════════════════════════════════════════════════════

set -e

echo "🚀 Starting deployment..."

# ── 1. System updates ────────────────────────────────────────────
echo "📦 Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# ── 2. Install Docker ────────────────────────────────────────────
echo "🐳 Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    echo "✅ Docker installed. You may need to log out and back in for group changes."
fi

# ── 3. Install Docker Compose ────────────────────────────────────
echo "🐳 Installing Docker Compose..."
if ! command -v docker compose &> /dev/null; then
    sudo apt-get install -y docker-compose-plugin
fi

# ── 4. Create project directory ──────────────────────────────────
APP_DIR="/home/$USER/grouping-algo"
echo "📁 Setting up project at $APP_DIR..."

if [ ! -d "$APP_DIR" ]; then
    mkdir -p "$APP_DIR"
fi

cd "$APP_DIR"

# ── 5. Create .env file (edit these values!) ─────────────────────
if [ ! -f .env ]; then
    echo "⚙️  Creating .env file..."
    cat > .env << 'EOF'
MONGODB_URL=mongodb+srv://karanbhardwaj1107_db_user:Q8VLRN2ZNUuFb89q@cluster0.tfiumja.mongodb.net/?appName=Cluster0
DATABASE_NAME=grouping_algo
MAX_RANGE_KM=50.0
CARTO_API_URL=https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_44h5_1_3e1bb155736670a1158fce56
EOF
    echo "⚠️  Review and update .env with your actual credentials!"
fi

# ── 6. Build and start containers ────────────────────────────────
echo "🏗️  Building Docker images..."
sudo docker compose build

echo "🟢 Starting services..."
sudo docker compose up -d

# ── 7. Verify ────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Deployment complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "🌐 App:      http://$(curl -s ifconfig.me)"
echo "📡 API Docs: http://$(curl -s ifconfig.me)/docs"
echo ""
echo "📋 Useful commands:"
echo "   docker compose logs -f        # View logs"
echo "   docker compose restart        # Restart"
echo "   docker compose down           # Stop"
echo "   docker compose up -d --build  # Rebuild & restart"
echo ""
