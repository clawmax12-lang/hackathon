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
  base    = "node"
  command = "npm ci"
}

service "api" {
  build   = build.api
  command = "npx tsx server/src/index.ts"

  pre_deploy {
    command = "npx tsx scripts/import-ikea-cloud-seed.ts"
  }

  endpoint {
    public = true

    health_check {
      path = "/api/healthz"
    }
  }

  volume "storage" {}

  env = {
    PORT                   = port
    DATABASE_URL           = postgres.catalog.url
    STORAGE_DIR            = volume.storage.path
    ANTHROPIC_API_KEY      = secret.anthropic_api_key
    ANTHROPIC_WORKSPACE_ID = secret.anthropic_workspace_id
    ELEVENLABS_API_KEY     = secret.elevenlabs_api_key
    FIRECRAWL_API_KEY      = secret.firecrawl_api_key
  }
}

secret "anthropic_api_key" {
  dev {
    required = false
  }
}

secret "anthropic_workspace_id" {
  dev {
    required = false
  }
}

secret "elevenlabs_api_key" {
  dev {
    required = false
  }
}

secret "firecrawl_api_key" {
  dev {
    required = false
  }
}

postgres "catalog" {
  reshape {
    enabled        = true
    migrations_dir = "db/migrations"
  }
}
