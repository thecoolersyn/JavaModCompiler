package com.jmc.autotool;

import net.minecraft.world.level.block.state.BlockState;

@FunctionalInterface
public interface ToolSpeedSource {
	float speedOf(int slot, BlockState target);
}
