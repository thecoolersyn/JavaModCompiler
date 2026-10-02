package com.jmc.autotool;

import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

public final class HotbarSpeedSource {
	public static final float NO_SPEED = 0.0F;

	private HotbarSpeedSource() {
	}

	public static float speedOf(Inventory inventory, int slot, BlockState target) {
		if (inventory == null || target == null || slot < 0 || slot >= AutoToolState.HOTBAR_SIZE) {
			return NO_SPEED;
		}

		ItemStack stack = inventory.getItem(slot);

		if (stack == null || stack.isEmpty()) {
			return NO_SPEED;
		}

		return stack.getDestroySpeed(target);
	}
}
