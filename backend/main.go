// OpenDay is a self-hosted calendar.
//
// This binary serves the JSON API under /api and the embedded React frontend
// for every other path.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	// Embed the time zone database so the image works without system tzdata.
	_ "time/tzdata"
)

func main() {
	addr := envOr("OPENDAY_ADDR", ":8080")
	dbPath := envOr("OPENDAY_DB", "openday.db")

	store, err := OpenStore(dbPath)
	if err != nil {
		log.Fatalf("open database %q: %v", dbPath, err)
	}
	defer store.Close()

	hub := NewHub()
	mux := http.NewServeMux()
	NewAPI(store, hub).Register(mux)
	mux.Handle("/", frontendHandler())

	srv := &http.Server{
		Addr:              addr,
		Handler:           secureHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	// Live update streams stay open forever; end them so Shutdown does not wait.
	srv.RegisterOnShutdown(hub.Close)

	go func() {
		log.Printf("OpenDay listening on %s (database: %s)", addr, dbPath)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	}()

	// Stop cleanly on Ctrl+C or `docker stop`.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Print("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// secureHeaders adds the browser protections the app needs. The app is a
// single-page app with no inline scripts, so a strict policy is possible;
// inline styles are used for positioning, so style-src allows them.
func secureHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; " +
		"manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
