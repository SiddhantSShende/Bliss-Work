import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { TasksListScreen } from '../screens/tasks/TasksListScreen';
import { TaskDetailScreen } from '../screens/tasks/TaskDetailScreen';
import { AssignTaskScreen } from '../screens/tasks/AssignTaskScreen';
import type { TasksStackParamList } from './types';

const Stack = createNativeStackNavigator<TasksStackParamList>();

export function TasksStackNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }}>
      <Stack.Screen name="TasksList" component={TasksListScreen} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} />
      <Stack.Screen name="AssignTask" component={AssignTaskScreen} />
    </Stack.Navigator>
  );
}
