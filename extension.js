import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Pango from "gi://Pango";
import Soup from "gi://Soup";

const FALLBACK_QUOTE = "TO A GREAT MIND NOTHING IS LITTLE..";
const QUOTE_FILE_NAME = "quote.txt";
const SETTINGS_FILE_NAME = "settings.json";
const QUOTE_REFRESH_INTERVAL_SECONDS = 60 * 60;
const QUOTE_MAX_WIDTH_RATIO = 0.4;
const QUOTE_MIN_WIDTH_PX = 280;
const QUOTE_EDGE_PADDING_PX = 30;
// const QUOTE_REFRESH_INTERVAL_SECONDS = 2; // Short interval for testing; change to 3600 for hourly refresh
const REMOTE_QUOTE_URL = "https://zenquotes.io/api/random";

export default class GnOteExtension {
  constructor() {
    this._overlay = null;
    this._container = null;
    this._label = null;
    this._menu = null;
    this._menuManager = null;
    this._monitorChangedId = null;
    this._quoteFile = null;
    this._quoteFileMonitor = null;
    this._refreshTimeoutId = null;
    this._httpSession = null;
    this._activeQuote = FALLBACK_QUOTE;
    this._dragging = false;
  }

  _loadSettings() {
    try {
      const [extensionFilePath] = GLib.filename_from_uri(import.meta.url);
      const extensionDir = GLib.path_get_dirname(extensionFilePath);
      const settingsPath = GLib.build_filenamev([extensionDir, SETTINGS_FILE_NAME]);
      const file = Gio.File.new_for_path(settingsPath);

      if (file.query_exists(null)) {
        const [ok, contents] = file.load_contents(null);
        if (ok) {
          return JSON.parse(new TextDecoder().decode(contents));
        }
      }
    } catch (e) {
      console.error(`[gnote] Failed to load settings: ${e}`);
    }
    return null;
  }

  _saveSettings() {
    if (!this._container) return;

    try {
      const monitor = Main.layoutManager.primaryMonitor;
      if (!monitor) return;

      const [x, y] = this._container.get_position();
      const settings = {
        xPercent: (x - monitor.x) / monitor.width,
        yPercent: (y - monitor.y) / monitor.height,
      };

      const [extensionFilePath] = GLib.filename_from_uri(import.meta.url);
      const extensionDir = GLib.path_get_dirname(extensionFilePath);
      const settingsPath = GLib.build_filenamev([extensionDir, SETTINGS_FILE_NAME]);
      const file = Gio.File.new_for_path(settingsPath);

      file.replace_contents(
        JSON.stringify(settings),
        null,
        false,
        Gio.FileCreateFlags.NONE,
        null
      );
    } catch (e) {
      console.error(`[gnote] Failed to save settings: ${e}`);
    }
  }

  enable() {
    this._overlay = new St.Widget({
      reactive: true,
      layout_manager: new Clutter.BinLayout(),
      x_expand: true,
      y_expand: true,
    });

    this._container = new St.BoxLayout({
      vertical: true,
      reactive: true,
      track_hover: true,
      x_expand: true,
      y_expand: true,
    });

    this._label = new St.Label({
      text: FALLBACK_QUOTE,
      style_class: "gnote-label",
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.START,
      x_expand: true,
      y_expand: true,
      style: `
                color: rgba(255, 255, 255, 0.85);
                font-size: 16px;
                font-weight: bold;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
                padding: 10px 15px;
                text-align: right;
            `,
    });

    this._menu = new PopupMenu.PopupMenu(this._container, 0.5, St.Side.TOP);
    this._menuManager = new PopupMenu.PopupMenuManager(this);
    this._menuManager.addMenu(this._menu);
    Main.uiGroup.add_child(this._menu.actor);
    this._menu.actor.hide();

    const menuItem = new PopupMenu.PopupMenuItem("Refresh Quote");
    menuItem.connect('activate', () => {
      this._refreshRemoteQuote();
    });
    this._menu.addMenuItem(menuItem);

    this._container.add_child(this._label);

    this._label.clutter_text.set_line_wrap(true);
    this._label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD);
    this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
    this._label.clutter_text.set_single_line_mode(false);
    this._label.clutter_text.set_line_alignment(Pango.Alignment.RIGHT);

    // Click logic: Left-click to drag, Right-click for menu
    this._container.connect('button-press-event', (actor, event) => {
      if (event.get_button() === 1) { // Left click
        this._dragging = true;
        const [x, y] = event.get_coords();
        this._dragStartX = x;
        this._dragStartY = y;
        const [actorX, actorY] = actor.get_position();
        this._actorStartX = actorX;
        this._actorStartY = actorY;
        return Clutter.EVENT_STOP;
      } else if (event.get_button() === 3) { // Right click
        this._menu.toggle();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    this._container.connect('motion-event', (actor, event) => {
      if (this._dragging) {
        const [x, y] = event.get_coords();
        const dx = x - this._dragStartX;
        const dy = y - this._dragStartY;
        actor.set_position(this._actorStartX + dx, this._actorStartY + dy);
        
        // Ensure manual positioning isn't overridden by alignment
        actor.set_x_align(Clutter.ActorAlign.START);
        actor.set_y_align(Clutter.ActorAlign.START);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    this._container.connect('button-release-event', (actor, event) => {
      if (this._dragging) {
        this._dragging = false;
        this._saveSettings();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    this._overlay.add_child(this._container);
    Main.layoutManager._backgroundGroup.add_child(this._overlay);

    this._positionLabel();
    this._setupQuoteFile();
    this._loadQuoteFromFile();
    this._refreshRemoteQuote();
    this._scheduleRemoteRefresh();

    this._monitorChangedId = Main.layoutManager.connect(
      "monitors-changed",
      () => this._positionLabel(),
    );
  }

  _positionLabel() {
    if (!this._container || !this._overlay) return;

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    this._overlay.set_position(monitor.x, monitor.y);
    this._overlay.set_size(monitor.width, monitor.height);

    const maxLabelWidth = Math.max(
      QUOTE_MIN_WIDTH_PX,
      Math.floor(monitor.width * QUOTE_MAX_WIDTH_RATIO),
    );

    this._container.set_width(maxLabelWidth);
    this._label.set_width(maxLabelWidth);

    const settings = this._loadSettings();
    if (settings && settings.xPercent !== undefined) {
      this._container.set_position(
        settings.xPercent * monitor.width,
        settings.yPercent * monitor.height
      );
      this._container.set_x_align(Clutter.ActorAlign.START);
      this._container.set_y_align(Clutter.ActorAlign.START);
    } else {
      this._container.set_x_align(Clutter.ActorAlign.END);
      this._container.set_y_align(Clutter.ActorAlign.END);
      this._container.set_style(
        `margin-right: ${QUOTE_EDGE_PADDING_PX}px; margin-bottom: ${QUOTE_EDGE_PADDING_PX}px;`
      );
    }
  }

  _setupQuoteFile() {
    const [extensionFilePath] = GLib.filename_from_uri(import.meta.url);
    const extensionDir = GLib.path_get_dirname(extensionFilePath);
    const quoteFilePath = GLib.build_filenamev([extensionDir, QUOTE_FILE_NAME]);

    this._quoteFile = Gio.File.new_for_path(quoteFilePath);

    if (!this._quoteFile.query_exists(null)) {
      this._quoteFile.replace_contents(
        `${FALLBACK_QUOTE}\n`,
        null,
        false,
        Gio.FileCreateFlags.NONE,
        null,
      );
    }

    this._quoteFileMonitor = this._quoteFile.monitor_file(
      Gio.FileMonitorFlags.NONE,
      null,
    );
    this._quoteFileMonitor.connect(
      "changed",
      (_monitor, _file, _otherFile, eventType) => {
        if (
          eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
          eventType === Gio.FileMonitorEvent.CREATED
        ) {
          this._loadQuoteFromFile();
        }
      },
    );
  }

  _loadQuoteFromFile() {
    if (!this._quoteFile) return;

    try {
      const [ok, contents] = this._quoteFile.load_contents(null);
      if (!ok) return;

      const quote = new TextDecoder().decode(contents).trim();
      this._setQuote(quote || FALLBACK_QUOTE);
    } catch (error) {
      console.error(`[gnote] Failed to read ${QUOTE_FILE_NAME}: ${error}`);
      this._setQuote(FALLBACK_QUOTE);
    }
  }

  _setQuote(quote) {
    const nextQuote = quote?.trim() || FALLBACK_QUOTE;
    this._activeQuote = nextQuote;

    if (!this._label) return;

    this._label.set_text(nextQuote);
    this._positionLabel();
  }

  _saveQuoteToFile(quote) {
    if (!this._quoteFile) return;

    try {
      this._quoteFile.replace_contents(
        `${quote}\n`,
        null,
        false,
        Gio.FileCreateFlags.NONE,
        null,
      );
    } catch (error) {
      console.error(`[gnote] Failed to save ${QUOTE_FILE_NAME}: ${error}`);
    }
  }

  _scheduleRemoteRefresh() {
    this._refreshTimeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      QUOTE_REFRESH_INTERVAL_SECONDS,
      () => {
        this._refreshRemoteQuote();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _refreshRemoteQuote() {
    if (!this._httpSession) {
      this._httpSession = new Soup.Session();
    }

    const message = Soup.Message.new("GET", REMOTE_QUOTE_URL);
    this._httpSession.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      null,
      (session, result) => {
        try {
          const bytes = session.send_and_read_finish(result);
          if (message.status_code !== Soup.Status.OK) {
            throw new Error(`HTTP ${message.status_code}`);
          }

          const payload = JSON.parse(
            new TextDecoder().decode(bytes.get_data()),
          );
          const remoteQuote = Array.isArray(payload) ? payload[0] : null;
          const quoteText = remoteQuote?.q?.trim();
          const author = remoteQuote?.a?.trim();

          if (!quoteText) {
            throw new Error("Response did not include a quote");
          }

          const latestQuote = author ? `${quoteText} - ${author}` : quoteText;
          this._setQuote(latestQuote);
          this._saveQuoteToFile(latestQuote);
        } catch (error) {
          console.error(`[gnote] Failed to refresh remote quote: ${error}`);
          this._loadQuoteFromFile();
        }
      },
    );
  }

  disable() {
    if (this._monitorChangedId) {
      Main.layoutManager.disconnect(this._monitorChangedId);
      this._monitorChangedId = null;
    }

    if (this._quoteFileMonitor) {
      this._quoteFileMonitor.cancel();
      this._quoteFileMonitor = null;
    }

    if (this._refreshTimeoutId) {
      GLib.source_remove(this._refreshTimeoutId);
      this._refreshTimeoutId = null;
    }

    if (this._httpSession) {
      this._httpSession.abort();
      this._httpSession = null;
    }

    if (this._menu) {
      this._menu.destroy();
      this._menu = null;
    }

    if (this._label) {
      this._label.destroy();
      this._label = null;
    }

    if (this._container) {
      this._container.destroy();
      this._container = null;
    }

    if (this._overlay) {
      this._overlay.destroy();
      this._overlay = null;
    }
  }
}
