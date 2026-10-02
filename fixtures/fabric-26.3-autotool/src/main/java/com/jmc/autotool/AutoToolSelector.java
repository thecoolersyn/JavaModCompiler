package com.jmc.autotool;

import net.minecraft.world.level.block.state.BlockState;

public final class AutoToolSelector {
	public static final int NO_CHANGE = -1;

	private static final float EPSILON = 1.0E-6F;

	private AutoToolSelector() {
	}

	public static int selectSlot(ToolSpeedSource speeds, int slotCount, int selectedSlot, BlockState target, boolean enabled) {
		if (!enabled || speeds == null || target == null) {
			return NO_CHANGE;
		}

		if (slotCount <= 0 || selectedSlot < 0 || selectedSlot >= slotCount) {
			return NO_CHANGE;
		}

		float bestSpeed = speed(speeds, selectedSlot, target);
		int bestSlot = NO_CHANGE;

		for (int slot = 0; slot < slotCount; slot++) {
			if (slot == selectedSlot) {
				continue;
			}

			float candidate = speed(speeds, slot, target);

			if (candidate > bestSpeed + EPSILON) {
				bestSpeed = candidate;
				bestSlot = slot;
			}
		}

		return bestSlot;
	}

	public static int resolveSlot(ToolSpeedSource speeds, int slotCount, int selectedSlot, BlockState target, boolean enabled) {
		int chosen = selectSlot(speeds, slotCount, selectedSlot, target, enabled);

		return chosen == NO_CHANGE ? selectedSlot : chosen;
	}

	private static float speed(ToolSpeedSource speeds, int slot, BlockState target) {
		float value = speeds.speedOf(slot, target);

		return value > 0.0F ? value : 0.0F;
	}
}
