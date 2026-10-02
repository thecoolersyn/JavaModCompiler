package com.jmc.autotool;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
public final class AutoToolRegistry {
	private static final List<String> REGISTERED = new ArrayList<>();

	private AutoToolRegistry() {
	}

	public static void register() {
		if (REGISTERED.isEmpty()) {
			REGISTERED.add("jmc_autotool");
			REGISTERED.add(COMMAND_ROOT);
			REGISTERED.add(TICK_HOOK);
			REGISTERED.add(CLIENT_GAME_TEST);
		}
	}

	public static final String COMMAND_ROOT = "jmctool-command";
	public static final String TICK_HOOK = "jmctool-end-client-tick";
	public static final String CLIENT_GAME_TEST = "jmctool-client-gametest";

	public static boolean isRegistered() {
		return REGISTERED.size() >= 4;
	}

	public static List<String> registeredIds() {
		return List.copyOf(REGISTERED);
	}

	public static float probeSpeed(ItemStack stack, BlockState target) {
		if (stack == null || stack.isEmpty() || target == null) {
			return 0.0F;
		}

		return stack.getDestroySpeed(target);
	}

	public static int evaluateHotbar(Inventory inventory, BlockState target, boolean enabled) {
		return AutoToolSelector.resolveSlot(
			(slot, block) -> HotbarSpeedSource.speedOf(inventory, slot, block),
			AutoToolState.HOTBAR_SIZE,
			inventory.getSelectedSlot(),
			target,
			enabled
		);
	}
}
