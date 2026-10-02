package com.jmc.autotool;

public final class AutoToolState {
	public static final int HOTBAR_SIZE = 9;

	private static final AutoToolState INSTANCE = new AutoToolState();

	private boolean enabled = true;
	private int lastSwitchCount;
	private int lastSelectedSlot = -1;

	private AutoToolState() {
	}

	public static AutoToolState instance() {
		return INSTANCE;
	}

	public boolean isEnabled() {
		return enabled;
	}

	public void setEnabled(boolean value) {
		this.enabled = value;
	}

	public void toggle() {
		this.enabled = !this.enabled;
	}

	public int lastSwitchCount() {
		return lastSwitchCount;
	}

	public int lastSelectedSlot() {
		return lastSelectedSlot;
	}

	public int hotbarSize() {
		return HOTBAR_SIZE;
	}

	public void recordSwitch(int slot) {
		this.lastSwitchCount += 1;
		this.lastSelectedSlot = slot;
	}

	public void resetCounters() {
		this.lastSwitchCount = 0;
		this.lastSelectedSlot = -1;
	}

	public String status() {
		return "JMC AutoTool " + (enabled ? "enabled" : "disabled")
			+ ", switches=" + lastSwitchCount
			+ ", lastSlot=" + lastSelectedSlot;
	}
}
