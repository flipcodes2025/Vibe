package nl.vibe.player;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VibePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
