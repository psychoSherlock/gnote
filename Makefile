UUID := gnote@psychosherlock
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall pack clean

## Copy the extension into your user extensions folder.
## Only the code is copied, so your saved quote and position are never overwritten.
install:
	mkdir -p $(DEST)
	cp extension.js metadata.json $(DEST)/
	@echo "Installed to $(DEST)"
	@echo "Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(DEST)

## Build a zip suitable for extensions.gnome.org / manual install.
pack:
	gnome-extensions pack --force --out-dir=dist .

clean:
	rm -rf dist
