// Command soksak-core embeds the frontend and launches the application composition.
package main

import (
	"embed"
	"log"

	"github.com/soksak-ai/soksak-core/internal/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if err := application.Run(assets); err != nil {
		log.Fatal(err)
	}
}
