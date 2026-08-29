build "web" {
  base    = "node"
  command = "npm run build"
}

service "web" {
  build   = build.web
  command = "npx serve dist -l $PORT"

  endpoint {
    public = true

    health_check {
      path = "/"
    }
  }

  env = {
    PORT = port
  }

  dev {
    command = "npm run dev -- --port $PORT"
    env = {
      API_ORIGIN = service.api.url
    }
  }
}

build "api" {
  dockerfile = "Dockerfile.api"
}

service "api" {
  build   = build.api
  command = "npx tsx scripts/start-api-with-catalog-sync.ts"

  endpoint {
    public = true

    health_check {
      path = "/api/healthz"
    }
  }

  volume "storage" {}

  env = {
    PORT         = port
    DATABASE_URL = postgres.catalog.url
    STORAGE_DIR  = volume.storage.path
  }
}

postgres "catalog" {
  reshape {
    enabled        = true
    migrations_dir = "db/migrations"
  }
}
