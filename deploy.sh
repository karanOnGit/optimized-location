#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# EC2 Deployment Script — Pickup & Drop Location Manager
# Run with: sudo bash deploy.sh
# ═══════════════════════════════════════════════════════════════════

set -e

echo "🚀 Starting deployment..."

# ── 1. System updates ────────────────────────────────────────────
echo "📦 Updating system packages..."
apt-get update -y
apt-get upgrade -y

# ── 2. Install Docker ────────────────────────────────────────────
echo "🐳 Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    usermod -aG docker ubuntu
    echo "✅ Docker installed."
fi

# ── 3. Install Docker Compose ────────────────────────────────────
echo "🐳 Installing Docker Compose..."
if ! command -v docker compose &> /dev/null; then
    apt-get install -y docker-compose-plugin
fi

# ── 4. Navigate to project directory ─────────────────────────────
APP_DIR="/var/www/optimized-location"
echo "📁 Using project at $APP_DIR..."

# Fix ownership so containers can read files
chown -R ubuntu:ubuntu "$APP_DIR"
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

# ── 6. Create nginx directory if missing ─────────────────────────
mkdir -p nginx

# ── 7. Build and start containers ────────────────────────────────
echo "🏗️  Building Docker images..."
docker compose build

echo "🟢 Starting services..."
docker compose up -d

# ── 8. Verify ────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Deployment complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "🌐 App:      http://$(curl -s ifconfig.me)"
echo "📡 API Docs: http://$(curl -s ifconfig.me)/docs"
echo ""
echo "📋 Useful commands:"
echo "   sudo docker compose logs -f        # View logs"
echo "   sudo docker compose restart        # Restart"
echo "   sudo docker compose down           # Stop"
echo "   sudo docker compose up -d --build  # Rebuild & restart"
echo ""
