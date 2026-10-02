package com.jmc.autotool;

import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.state.BlockState;

public final class AutoToolScenarios {
	private AutoToolScenarios() {
	}

	public static int selectFrom(Inventory inventory, BlockState target, boolean enabled) {
		return AutoToolSelector.resolveSlot(
			(slot, block) -> HotbarSpeedSource.speedOf(inventory, slot, block),
			AutoToolState.HOTBAR_SIZE,
			inventory.getSelectedSlot(),
			target,
			enabled
		);
	}

	public static void clearHotbar(Inventory inventory) {
		for (int slot = 0; slot < AutoToolState.HOTBAR_SIZE; slot++) {
			inventory.setItem(slot, ItemStack.EMPTY);
		}
	}

	public static void fill(Inventory inventory, ItemStack... stacks) {
		clearHotbar(inventory);

		for (int slot = 0; slot < stacks.length && slot < AutoToolState.HOTBAR_SIZE; slot++) {
			inventory.setItem(slot, stacks[slot]);
		}
	}

	public static boolean betterToolIsSelected(Inventory inventory, BlockState target) {
		inventory.setItem(0, new ItemStack(Items.STONE));
		inventory.setItem(1, new ItemStack(Items.DIAMOND_PICKAXE));
		inventory.setSelectedSlot(0);

		return selectFrom(inventory, target, true) == 1;
	}

	public static boolean noSuitableToolKeepsSlot(Inventory inventory, BlockState target) {
		inventory.setItem(0, new ItemStack(Items.STICK));
		inventory.setItem(1, new ItemStack(Items.DIRT));
		inventory.setSelectedSlot(0);

		return selectFrom(inventory, target, true) == 0;
	}

	public static boolean equalToolDoesNotSwitch(Inventory inventory, BlockState target) {
		inventory.setItem(0, new ItemStack(Items.DIAMOND_PICKAXE));
		inventory.setItem(1, new ItemStack(Items.DIAMOND_PICKAXE));
		inventory.setSelectedSlot(0);

		return selectFrom(inventory, target, true) == 0;
	}

	public static boolean nonToolIsIgnored(Inventory inventory, BlockState target) {
		inventory.setItem(0, new ItemStack(Items.DIAMOND_PICKAXE));
		inventory.setItem(1, new ItemStack(Items.STICK));
		inventory.setSelectedSlot(0);

		return selectFrom(inventory, target, true) == 0;
	}

	public static boolean emptySlotIsIgnored(Inventory inventory, BlockState target) {
		inventory.setItem(0, new ItemStack(Items.DIAMOND_PICKAXE));
		inventory.setItem(1, ItemStack.EMPTY);
		inventory.setItem(2, ItemStack.EMPTY);
		inventory.setSelectedSlot(0);

		return selectFrom(inventory, target, true) == 0;
	}

	public static boolean disabledNeverSwitches(Inventory inventory, BlockState target) {
		inventory.setItem(0, new ItemStack(Items.STONE));
		inventory.setItem(1, new ItemStack(Items.DIAMOND_PICKAXE));
		inventory.setSelectedSlot(0);

		return selectFrom(inventory, target, false) == 0;
	}

	public static boolean correctToolClassIsPreferred(Inventory inventory, BlockState target) {
		inventory.setItem(0, new ItemStack(Items.DIAMOND_PICKAXE));
		inventory.setItem(1, new ItemStack(Items.DIAMOND_AXE));
		inventory.setSelectedSlot(0);

		return selectFrom(inventory, target, true) == 1;
	}

	public static String describe() {
		return "JMC AutoTool scenarios";
	}
}
