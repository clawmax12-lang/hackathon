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
  }
}

postgres "catalog" {
  reshape {
    enabled        = true
    migrations_dir = "db/migrations"
  }
}
