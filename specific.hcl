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

config "guide_price_sek" {
  default = "49"
}

config "anthropic_orchestrator_model" {
  default = "claude-opus-5"
}

config "anthropic_vision_model" {
  default = "claude-haiku-4-5"
}

config "anthropic_orchestrator_prompt_version" {
  default = "monterra-system-v2"
}

config "anthropic_effort_orchestrator" {
  default = "default"
}

config "anthropic_effort_vision" {
  default = "default"
}

config "anthropic_effort_qa" {
  default = "default"
}

config "ikea_market" {
  default = "se"
}

config "ikea_language" {
  default = "sv"
}

config "job_concurrency" {
  default = "2"
}

build "web" {
  base    = "node"
  command = "npm run build"

  env = {
    VITE_API_ORIGIN = "https://${service.api.public_url}"
  }
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
      API_ORIGIN = "http://${service.api.url}"
    }
  }
}

build "api" {
  dockerfile = "Dockerfile.api"
}

service "api" {
  build   = build.api
  command = "npx tsx server/src/index.ts"

  endpoint {
    public = true

    health_check {
      path = "/api/healthz"
    }
  }

  volume "storage" {}

  env = {
    PORT                           = port
    DATABASE_URL                   = postgres.catalog.url
    STORAGE_DIR                    = volume.storage.path
    ANTHROPIC_API_KEY              = secret.anthropic_api_key
    ANTHROPIC_WORKSPACE_ID         = secret.anthropic_workspace_id
    ANTHROPIC_ORCHESTRATOR_MODEL   = config.anthropic_orchestrator_model
    ANTHROPIC_VISION_MODEL         = config.anthropic_vision_model
    ANTHROPIC_ORCHESTRATOR_PROMPT_VERSION = config.anthropic_orchestrator_prompt_version
    ANTHROPIC_EFFORT_ORCHESTRATOR  = config.anthropic_effort_orchestrator
    ANTHROPIC_EFFORT_VISION        = config.anthropic_effort_vision
    ANTHROPIC_EFFORT_QA            = config.anthropic_effort_qa
    ELEVENLABS_API_KEY             = secret.elevenlabs_api_key
    FIRECRAWL_API_KEY              = secret.firecrawl_api_key
    GUIDE_PRICE_SEK                = config.guide_price_sek
    IKEA_MARKET                    = config.ikea_market
    IKEA_LANGUAGE                  = config.ikea_language
    JOB_CONCURRENCY                = config.job_concurrency
  }
}

postgres "catalog" {
  reshape {
    enabled        = true
    migrations_dir = "db/migrations"
  }
}
