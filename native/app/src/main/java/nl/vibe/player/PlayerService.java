package nl.vibe.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaMetadataRetriever;
import android.media.MediaPlayer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import java.util.ArrayList;
import java.util.Random;

/** Speelt muziek af op de achtergrond, ook met een vergrendeld scherm. */
public class PlayerService extends Service {
    static final String A_QUEUE = "nl.vibe.player.QUEUE";
    static final String A_PLAY = "nl.vibe.player.PLAY";
    static final String A_PAUSE = "nl.vibe.player.PAUSE";
    static final String A_TOGGLE = "nl.vibe.player.TOGGLE";
    static final String A_NEXT = "nl.vibe.player.NEXT";
    static final String A_PREV = "nl.vibe.player.PREV";
    static final String A_BACK = "nl.vibe.player.BACK";
    static final String A_SEEK = "nl.vibe.player.SEEK";
    static final String A_SHUFFLE = "nl.vibe.player.SHUFFLE";
    static final String A_REPEAT = "nl.vibe.player.REPEAT";
    static final String A_STOP = "nl.vibe.player.STOP";

    private static final String CH = "vibe_playback";
    private static final int NID = 7;

    static class Track {
        String path, uri;
        String title = "", artist = "", album = "";
        double duration;
    }

    interface Listener {
        void onState(boolean playing, int index, double pos, double dur, long qid);
    }

    static PlayerService instance;
    static Listener listener;
    static volatile String[] pendingPaths;

    private final ArrayList<Track> queue = new ArrayList<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Random rnd = new Random();
    private MediaPlayer mp;
    private MediaSession session;
    private AudioManager am;
    private AudioFocusRequest focusReq;
    private Bitmap cover;
    private int index = -1, repeat = 0, errors = 0;
    private boolean shuffle, prepared, playing, wantPlay, foreground;
    private long qid;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (playing) {
                emit();
                handler.postDelayed(this, 500);
            }
        }
    };

    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (playing) pauseNow();
        }
    };

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
                pauseNow();
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                if (playing) {
                    pauseNow();
                    wantPlay = true; // hervatten zodra de focus terugkomt
                }
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                if (mp != null) mp.setVolume(0.25f, 0.25f);
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                if (mp != null) mp.setVolume(1f, 1f);
                if (wantPlay && !playing) resume();
                break;
            default:
                break;
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        NotificationChannel c = new NotificationChannel(CH, "Afspelen", NotificationManager.IMPORTANCE_LOW);
        c.setShowBadge(false);
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).createNotificationChannel(c);

        session = new MediaSession(this, "Vibe");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { resume(); }
            @Override public void onPause() { pauseNow(); }
            @Override public void onSkipToNext() { skip(1, false); }
            @Override public void onSkipToPrevious() { prevOrRestart(); }
            @Override public void onSeekTo(long pos) { seekTo(pos / 1000.0); }
            @Override public void onStop() { pauseNow(); }
        });
        session.setActive(true);
        registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
    }

    @Override public int onStartCommand(Intent in, int flags, int startId) {
        String a = in == null ? null : in.getAction();
        if (a == null) {
            if (!foreground) stopSelf();
            return START_NOT_STICKY;
        }
        switch (a) {
            case A_QUEUE:
                startFg(buildNotification()); // moet snel na startForegroundService
                setQueue(in);
                break;
            case A_PLAY: resume(); break;
            case A_PAUSE: pauseNow(); break;
            case A_TOGGLE:
                if (playing) pauseNow(); else resume();
                break;
            case A_NEXT: skip(1, false); break;
            case A_BACK: skip(-1, false); break;
            case A_PREV: prevOrRestart(); break;
            case A_SEEK: seekTo(in.getDoubleExtra("pos", 0)); break;
            case A_SHUFFLE: shuffle = in.getBooleanExtra("on", false); break;
            case A_REPEAT: repeat = in.getIntExtra("mode", 0); break;
            case A_STOP: shutdown(); break;
            default: break;
        }
        return START_NOT_STICKY;
    }

    // ---------- wachtrij en afspelen ----------

    private void setQueue(Intent in) {
        String[] paths = pendingPaths;
        pendingPaths = null;
        queue.clear();
        if (paths != null) {
            for (String p : paths) {
                Track t = VibePlugin.LIBRARY.get(p);
                if (t != null) queue.add(t);
            }
        }
        qid = in.getLongExtra("qid", 0);
        shuffle = in.getBooleanExtra("shuffle", false);
        repeat = in.getIntExtra("repeat", 0);
        errors = 0;
        if (queue.isEmpty()) {
            shutdown();
            return;
        }
        wantPlay = true;
        int i = in.getIntExtra("index", 0);
        playIndex(Math.max(0, Math.min(i, queue.size() - 1)));
    }

    private Track cur() {
        return index >= 0 && index < queue.size() ? queue.get(index) : null;
    }

    private AudioAttributes attrs() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build();
    }

    private void playIndex(int i) {
        if (i < 0 || i >= queue.size()) return;
        index = i;
        prepared = false;
        playing = false;
        cover = null;
        Track t = queue.get(i);
        try {
            if (mp == null) {
                mp = new MediaPlayer();
                mp.setWakeMode(getApplicationContext(), PowerManager.PARTIAL_WAKE_LOCK);
                mp.setOnPreparedListener(m -> {
                    prepared = true;
                    errors = 0;
                    if (wantPlay && requestFocus()) {
                        m.start();
                        playing = true;
                    } else {
                        wantPlay = false;
                    }
                    startTicker();
                    updateAll();
                });
                mp.setOnCompletionListener(m -> onComplete());
                mp.setOnErrorListener((m, what, extra) -> {
                    skipBad();
                    return true;
                });
            } else {
                mp.reset();
            }
            mp.setAudioAttributes(attrs());
            mp.setVolume(1f, 1f);
            mp.setDataSource(getApplicationContext(), Uri.parse(t.uri));
            mp.prepareAsync();
        } catch (Exception e) {
            skipBad();
            return;
        }
        updateAll();
        loadCover(t);
    }

    private void skipBad() {
        prepared = false;
        playing = false;
        if (++errors >= queue.size()) {
            wantPlay = false;
            updateAll();
            return;
        }
        skip(1, true);
    }

    private void onComplete() {
        if (repeat == 2 && mp != null) {
            mp.seekTo(0);
            mp.start();
            playing = true;
            updateAll();
        } else {
            skip(1, true);
        }
    }

    private void skip(int d, boolean auto) {
        int n = queue.size();
        if (n == 0) return;
        int j;
        if (shuffle && n > 1) {
            do { j = rnd.nextInt(n); } while (j == index);
        } else {
            j = index + d;
            if (j < 0 || j >= n) {
                if (auto && repeat == 0) {
                    playing = false;
                    wantPlay = false;
                    updateAll();
                    return;
                }
                j = (j + n) % n;
            }
        }
        wantPlay = true;
        playIndex(j);
    }

    private void prevOrRestart() {
        if (position() > 3) seekTo(0); else skip(-1, false);
    }

    private void resume() {
        wantPlay = true;
        if (mp == null || !prepared) {
            updateAll();
            return;
        }
        if (!requestFocus()) {
            wantPlay = false;
            return;
        }
        mp.start();
        playing = true;
        startTicker();
        updateAll();
    }

    private void pauseNow() {
        wantPlay = false;
        if (mp != null && prepared && mp.isPlaying()) mp.pause();
        playing = false;
        updateAll();
    }

    private void seekTo(double sec) {
        if (mp != null && prepared) mp.seekTo((int) (sec * 1000));
        updateSession();
        emit();
    }

    private void shutdown() {
        wantPlay = false;
        playing = false;
        if (mp != null && prepared && mp.isPlaying()) mp.pause();
        emit();
        stopForeground(STOP_FOREGROUND_REMOVE);
        foreground = false;
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).cancel(NID);
        stopSelf();
    }

    private boolean requestFocus() {
        if (focusReq == null) {
            focusReq = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs())
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
        }
        return am.requestAudioFocus(focusReq) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    // ---------- toestand doorgeven ----------

    double position() {
        try {
            return mp != null && prepared ? mp.getCurrentPosition() / 1000.0 : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    double duration() {
        try {
            if (mp != null && prepared) {
                int d = mp.getDuration();
                if (d > 0) return d / 1000.0;
            }
        } catch (Exception ignored) { }
        Track t = cur();
        return t != null ? t.duration : 0;
    }

    boolean isPlaying() { return playing; }
    int currentIndex() { return index; }
    long currentQid() { return qid; }

    ArrayList<String> paths() {
        ArrayList<String> out = new ArrayList<>();
        for (Track t : queue) out.add(t.path);
        return out;
    }

    private void emit() {
        Listener l = listener;
        if (l != null) l.onState(playing, index, position(), duration(), qid);
    }

    private void startTicker() {
        handler.removeCallbacks(tick);
        handler.post(tick);
    }

    // ---------- melding, vergrendelscherm, albumhoes ----------

    private void startFg(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NID, n);
        }
        foreground = true;
    }

    private void updateAll() {
        updateSession();
        Notification n = buildNotification();
        if (playing || wantPlay) {
            startFg(n);
        } else {
            if (foreground) {
                stopForeground(STOP_FOREGROUND_DETACH);
                foreground = false;
            }
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NID, n);
        }
        emit();
    }

    private void updateSession() {
        Track t = cur();
        if (t != null) {
            MediaMetadata.Builder mb = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, t.title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, t.artist)
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, t.album)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (duration() * 1000));
            if (cover != null) mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cover);
            session.setMetadata(mb.build());
        }
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        (long) (position() * 1000), 1f)
                .build());
    }

    private PendingIntent pi(String action) {
        Intent i = new Intent(this, PlayerService.class).setAction(action);
        return PendingIntent.getService(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification.Action act(int icon, String title, String action) {
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), title, pi(action)).build();
    }

    private Notification buildNotification() {
        Track t = cur();
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        boolean active = playing || wantPlay;
        Notification.Builder b = new Notification.Builder(this, CH)
                .setSmallIcon(R.drawable.ic_stat_vibe)
                .setContentTitle(t != null ? t.title : "Vibe")
                .setContentText(t != null ? t.artist : "")
                .setContentIntent(PendingIntent.getActivity(this, 0, open,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .setDeleteIntent(pi(A_STOP))
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(active)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .addAction(act(android.R.drawable.ic_media_previous, "Vorige", A_PREV))
                .addAction(act(active ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        active ? "Pauze" : "Afspelen", A_TOGGLE))
                .addAction(act(android.R.drawable.ic_media_next, "Volgende", A_NEXT))
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2));
        if (cover != null) b.setLargeIcon(cover);
        return b.build();
    }

    private void loadCover(final Track t) {
        new Thread(() -> {
            Bitmap bm = null;
            try {
                MediaMetadataRetriever r = new MediaMetadataRetriever();
                r.setDataSource(getApplicationContext(), Uri.parse(t.uri));
                byte[] b = r.getEmbeddedPicture();
                r.release();
                if (b != null) bm = VibePlugin.decodeScaled(b, 512);
            } catch (Exception ignored) { }
            final Bitmap fin = bm;
            handler.post(() -> {
                if (fin != null && cur() == t) {
                    cover = fin;
                    updateAll();
                }
            });
        }).start();
    }

    // ---------- opruimen ----------

    @Override public void onTaskRemoved(Intent rootIntent) {
        if (!playing && !wantPlay) shutdown();
    }

    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        playing = false;
        emit();
        try { unregisterReceiver(noisy); } catch (Exception ignored) { }
        if (focusReq != null) am.abandonAudioFocusRequest(focusReq);
        if (mp != null) { mp.release(); mp = null; }
        if (session != null) session.release();
        instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}
